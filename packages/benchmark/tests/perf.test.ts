import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AnalysisStats } from '@ckg/shared';
import {
  MIN_SAMPLES_FOR_P95,
  NO_MATCH_TERM,
  PERF_REPORT_SCHEMA,
  QUERY_CSV_COLUMNS,
  RUN_CSV_COLUMNS,
  TRAVERSAL_DEPTHS,
  captureEnvironment,
  csvCell,
  nearestRank,
  parseManifest,
  parseServerTiming,
  planQueries,
  resultCountOf,
  runQueries,
  selectRepositories,
  seriesOf,
  summarize,
  summarizeQueries,
  summarizeRuns,
  toCsv,
  validateManifest,
  ManifestError,
  type QueryRecord,
  type RunRecord,
} from '../src/index.js';

/**
 * The performance benchmark's own logic: everything that decides what is
 * recorded and how it is summarised. None of this measures anything; the
 * measurements come from real runs of `scripts/perf-benchmark.ts`.
 */

const MANIFEST = fileURLToPath(new URL('../../../benchmarks/repositories.json', import.meta.url));

const validRepository = {
  id: 'sample',
  url: 'https://github.com/example/sample',
  commit: 'a'.repeat(40),
  ref: 'v1.0.0',
  tier: 'S',
  purpose: 'a test',
  languages: ['typescript'],
  setup: { installDependencies: false },
};

describe('the repository manifest', () => {
  it('the checked-in manifest is valid and pins every repository to a full SHA', async () => {
    const manifest = parseManifest(JSON.parse(await readFile(MANIFEST, 'utf8')));

    expect(manifest.repositories.map((repo) => repo.id)).toEqual([
      'ky',
      'express',
      'zod',
      'realworld-express',
      'immich-server',
    ]);
    for (const repo of manifest.repositories) expect(repo.commit).toMatch(/^[0-9a-f]{40}$/);
    // The immich pin is the revision of the earlier validation report.
    expect(manifest.repositories.find((repo) => repo.id === 'immich-server')?.commit.startsWith('a4af862')).toBe(true);
  });

  it('accepts a minimal valid manifest', () => {
    expect(validateManifest({ schema: 1, repositories: [validRepository] })).toEqual([]);
  });

  it('rejects an abbreviated SHA, which can become ambiguous, and a branch name', () => {
    for (const commit of ['a4af862', 'main', 'A'.repeat(40)]) {
      expect(validateManifest({ schema: 1, repositories: [{ ...validRepository, commit }] })[0]).toContain(
        'full 40-character',
      );
    }
  });

  it('reports every problem at once', () => {
    const problems = validateManifest({
      schema: 2,
      repositories: [
        { ...validRepository, tier: 'huge', languages: ['python'], subdirectory: '../outside' },
        { ...validRepository },
      ],
    });

    expect(problems.join('\n')).toMatch(/schema must be 1/);
    expect(problems.join('\n')).toMatch(/tier must be one of/);
    expect(problems.join('\n')).toMatch(/languages must list languages the pipeline indexes/);
    expect(problems.join('\n')).toMatch(/subdirectory must be a relative path/);
    expect(problems.join('\n')).toMatch(/sample is listed twice/);
  });

  it('accepts a pinned, script-free tarball preparation, and rejects ranges, missing integrity and scripts', () => {
    const preparation = {
      profile: 'tsconfig-only',
      kind: 'tarball-extract',
      package: '@sindresorhus/tsconfig',
      version: '8.1.0',
      tarball: 'https://registry.npmjs.org/@sindresorhus/tsconfig/-/tsconfig-8.1.0.tgz',
      integrity: 'sha512-MggpguA4jNdtyoUy2Hs54nb4lP4rbhH34CsOiFId1q6fmFPnipqeo70ZRkjp5p4Z7wdyspALtSAcKaxL2/3waQ==',
      scripts: 'never',
    };
    const prepared = { ...validRepository, setup: { installDependencies: true }, preparation };
    expect(validateManifest({ schema: 1, repositories: [prepared] })).toEqual([]);

    const problems = validateManifest({
      schema: 1,
      repositories: [{ ...prepared, setup: { installDependencies: false }, preparation: { ...preparation, version: '^8.1.0', integrity: 'md5-x', scripts: 'allowed' } }],
    }).join('\n');
    expect(problems).toMatch(/exact version/);
    expect(problems).toMatch(/sha512 integrity/);
    expect(problems).toMatch(/scripts must be "never"/);
    expect(problems).toMatch(/installDependencies to true/);

    // Both become path segments: traversal is refused.
    const traversal = validateManifest({
      schema: 1,
      repositories: [{ ...prepared, preparation: { ...preparation, profile: '../escape', package: '../../x' } }],
    }).join('\n');
    expect(traversal).toMatch(/profile must be/);
    expect(traversal).toMatch(/valid npm package name/);
  });

  it('keeps a manifest to one series: wholly dependency-free or wholly prepared', () => {
    const preparation = {
      profile: 'p', kind: 'tarball-extract', package: 'x', version: '1.0.0', tarball: 'https://x/x.tgz', integrity: 'sha512-AA==', scripts: 'never',
    };
    const prepared = { ...validRepository, id: 'prepared', setup: { installDependencies: true }, preparation };
    expect(seriesOf(parseManifest({ schema: 1, repositories: [validRepository] }))).toBe('dependency-free');
    expect(seriesOf(parseManifest({ schema: 1, repositories: [prepared] }))).toBe('dependency-prepared');
    expect(() => seriesOf(parseManifest({ schema: 1, repositories: [validRepository, prepared] }))).toThrow(ManifestError);
  });

  it('selects by id, in manifest order, and refuses an unknown one', () => {
    const manifest = parseManifest({
      schema: 1,
      repositories: [validRepository, { ...validRepository, id: 'other' }],
    });

    expect(selectRepositories(manifest, ['other', 'sample']).map((repo) => repo.id)).toEqual(['sample', 'other']);
    expect(selectRepositories(manifest, null)).toHaveLength(2);
    expect(() => selectRepositories(manifest, ['nope'])).toThrow(ManifestError);
  });
});

describe('summary statistics', () => {
  it('computes min, median and max, and withholds p95 from a small sample', () => {
    const summary = summarize([5, 1, 3, 2, 4]);

    expect(summary).toMatchObject({ count: 5, min: 1, median: 3, max: 5, p95: null });
    expect(summary.p95Note).toContain(`below ${String(MIN_SAMPLES_FOR_P95)}`);
  });

  it('takes the mean of the middle two for an even count', () => {
    expect(summarize([4, 1, 3, 2]).median).toBe(2.5);
  });

  it('reports a nearest-rank p95 once there are enough observations', () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);

    expect(summarize(values).p95).toBe(19);
    expect(nearestRank([10], 0.95)).toBe(10);
  });

  it('leaves out missing measurements instead of counting them as zero', () => {
    expect(summarize([null, 10, undefined, Number.NaN, 20])).toMatchObject({ count: 2, min: 10, max: 20 });
    expect(summarize([null, null])).toMatchObject({ count: 0, min: null, median: null });
  });
});

describe('run records, summaries and CSV', () => {
  const stats = (totalMs: number, incomplete = false): AnalysisStats =>
    ({
      documentCount: 1,
      symbolCount: 1,
      nodeCount: 10,
      edgeCount: 20,
      durationMs: Math.round(totalMs),
      fileCount: 3,
      timings: { totalMs, phases: { scipIndex: totalMs / 2, persist: 1 }, analyzers: [], unattributedMs: 0 },
      completeness: {
        incomplete,
        reasons: incomplete ? ['source_file_limit'] : [],
        unresolvedReferences: { total: 3, external: 2, unmodelled: 1, unknown: 0 },
        droppedEdges: { total: 0, byAnalyzer: {} },
        analyzers: { run: ['scip'], failed: [] },
        scan: null,
        sourceRead: null,
        unreadableFiles: 0,
      },
    }) as AnalysisStats;

  const record = (index: number, overrides: Partial<RunRecord> = {}): RunRecord => ({
    repository: {
      id: 'sample',
      url: 'https://github.com/example/sample',
      commit: 'a'.repeat(40),
      ref: 'v1',
      tier: 'S',
      subdirectory: null,
      trackedFiles: 4,
      sourceFiles: 3,
      sourceLines: 120,
    },
    run: {
      index,
      phase: index === 0 ? 'initial' : 'reindex',
      kind: index === 0 ? 'initial-index' : 're-index',
      sample: index === 0 ? 1 : index,
      startedAt: '2026-10-12T00:00:00.000Z',
      cacheState: {
        freshProcess: true,
        projectGraphPreexisting: index > 0,
        freshWorkspace: true,
        checkoutPreexisting: true,
        checkoutPristine: true,
        databaseSettled: index === 0,
        osPageCacheReset: false,
        databaseBufferCacheReset: false,
      },
    },
    outcome: 'completed',
    error: null,
    jobStatus: 'COMPLETED',
    persistence: 'postgres',
    harnessWallMs: 500,
    stats: stats(100 + index),
    scip: null,
    databaseBefore: null,
    settle: null,
    database: null,
    ...overrides,
  });

  it('summarises initial indexes and re-indexes apart, keeping failed and incomplete runs in the counts', () => {
    const records = [
      record(0),
      record(1),
      record(2, { outcome: 'failed', error: 'scip-typescript exited with code 1', stats: null, jobStatus: 'FAILED' }),
      record(3, { stats: stats(140, true) }),
      record(4, { outcome: 'harness_error', error: 'no result', stats: null, jobStatus: null }),
    ];
    const [cold, warm] = summarizeRuns(records);

    expect(cold).toMatchObject({ kind: 'initial-index', runs: 1, completed: 1, failed: 0 });
    expect(warm).toMatchObject({ kind: 're-index', runs: 4, completed: 2, failed: 2, incomplete: 1 });
    // Graph size is summarised beside the timings.
    expect(warm?.metrics['graph.nodes']).toMatchObject({ count: 2, min: 10, max: 10 });
    // Only completed runs contribute timings; a failure is not a fast run.
    expect(warm?.metrics.totalMs).toMatchObject({ count: 2, min: 101, max: 140 });
    // A metric nothing measured has no observations rather than zeros.
    expect(warm?.metrics['scip.wallMs']).toMatchObject({ count: 0, median: null });
  });

  it('keeps a re-index-phase run that found no graph apart from the real initial-index samples', () => {
    const failedFirst = record(1, {
      run: { ...record(1).run, kind: 'initial-index', phase: 'reindex', cacheState: { ...record(1).run.cacheState, projectGraphPreexisting: false, databaseSettled: false } },
    });
    const groups = summarizeRuns([record(0), failedFirst]).map((entry) => [entry.kind, entry.phase, entry.runs]);

    expect(groups).toEqual([
      ['initial-index', 'initial', 1],
      ['initial-index', 'reindex', 1],
    ]);
  });

  it('writes one CSV row per run, with blanks for what was not measured', () => {
    const csv = toCsv([record(0), record(1, { outcome: 'failed', error: 'boom, badly', stats: null })], RUN_CSV_COLUMNS);
    const [header, cold, failed] = csv.trimEnd().split('\n');

    expect(header?.split(',')).toEqual(RUN_CSV_COLUMNS.map(([name]) => name));
    expect(cold).toContain(',initial-index,');
    expect(failed).toContain('"boom, badly"');
    const cells = (failed ?? '').split(',');
    const totalColumn = RUN_CSV_COLUMNS.findIndex(([name]) => name === 'total_ms');
    // Shifted by one for the quoted comma in the error.
    expect(cells[totalColumn + 1]).toBe('');
  });

  it('quotes and joins cells the way CSV readers expect', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(['a', 'b'])).toBe('a;b');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(false)).toBe('false');
  });

  it('keeps the report schema version explicit', () => {
    expect(PERF_REPORT_SCHEMA).toBe(2);
  });
});

describe('the query workload', () => {
  const targets = [
    { id: 'n1', name: 'createApplication', type: 'function', filePath: 'lib/express.js' },
    { id: 'n2', name: 'Router', type: 'class', filePath: null },
  ];

  it('keys every question by stable identity, never by project-scoped id', () => {
    // Same targets, ids from a different project: the keys must not change.
    const first = planQueries('p1', targets);
    const second = planQueries('p2', targets.map((target) => ({ ...target, id: `${target.id}-other-project` })));

    expect(second.map((query) => query.key)).toEqual(first.map((query) => query.key));
    expect(new Set(first.map((query) => `${query.kind}|${query.key}`)).size).toBe(first.length);
    for (const query of first) expect(query.key).not.toMatch(/n1|n2/);
    expect(first.find((query) => query.kind === 'traverse')?.key).toBe('depth=1&limit=500&root=function:createApplication@lib/express.js');
  });

  it('plans search, node detail, traversal at depths 1 to 5, and paths', () => {
    const plan = planQueries('p', targets);
    const kinds = plan.map((query) => query.kind);

    expect(kinds.filter((kind) => kind === 'search')).toHaveLength(4); // two names, a prefix, no match
    expect(plan.some((query) => query.params.q === NO_MATCH_TERM)).toBe(true);
    expect(kinds.filter((kind) => kind === 'node_detail')).toHaveLength(2);
    expect(plan.filter((query) => query.kind === 'traverse').map((query) => query.params.depth)).toEqual([
      ...TRAVERSAL_DEPTHS,
      ...TRAVERSAL_DEPTHS,
    ]);
    expect(plan.filter((query) => query.kind === 'path')).toEqual([
      expect.objectContaining({ method: 'POST', body: { from: 'n1', to: 'n2', maxDepth: 6 } }),
    ]);
  });

  it('reads the server duration from Server-Timing, and nothing else', () => {
    expect(parseServerTiming('app;dur=12.34')).toBe(12.34);
    expect(parseServerTiming('db;dur=1, app;dur=3')).toBe(3);
    expect(parseServerTiming(null)).toBeNull();
    expect(parseServerTiming('cache;desc=hit')).toBeNull();
  });

  it('counts results by shape', () => {
    expect(resultCountOf([1, 2, 3])).toBe(3);
    expect(resultCountOf({ nodes: [1, 2], edges: [] })).toBe(2);
    expect(resultCountOf({ node: { id: 'x' } })).toBe(1);
    expect(resultCountOf({ found: false })).toBeNull();
  });

  it('times each request, keeps failures, and separates client from server time', async () => {
    let clock = 0;
    const responses = [
      new Response(JSON.stringify({ success: true, data: [1, 2], meta: { truncated: false } }), {
        status: 200,
        headers: { 'server-timing': 'app;dur=4.5' },
      }),
      new Response(JSON.stringify({ success: false, data: null, error: { message: 'Node not found' } }), {
        status: 404,
      }),
    ];
    const fetchImpl = (async () => {
      clock += 10;
      const next = responses.shift();
      if (!next) throw new Error('connection refused');
      return next;
    }) as unknown as typeof fetch;

    const records: QueryRecord[] = await runQueries(
      [
        { kind: 'search', method: 'GET', path: '/a', key: 'q=x', params: { q: 'x' } },
        { kind: 'node_detail', method: 'GET', path: '/b', key: 'node=gone', params: { nodeId: 'gone' } },
        { kind: 'path', method: 'POST', path: '/c', body: {}, key: 'from=a', params: { from: 'a' } },
      ],
      { baseUrl: 'http://bench', repositoryId: 'r', projectId: 'p', iterations: 1, round: 1, fetchImpl, now: () => clock },
    );

    expect(records[0]).toMatchObject({ ok: true, status: 200, clientMs: 10, serverMs: 4.5, resultCount: 2, truncated: false });
    expect(records[1]).toMatchObject({ ok: false, status: 404, serverMs: null, error: 'Node not found' });
    expect(records[2]).toMatchObject({ ok: false, status: null, clientMs: null, error: 'connection refused' });

    expect(records.every((record) => record.round === 1 && !record.warmup && typeof record.at === 'string')).toBe(true);
    expect(toCsv(records, QUERY_CSV_COLUMNS).split('\n')[0]).toBe(QUERY_CSV_COLUMNS.map(([name]) => name).join(','));
  });

  it('reads a path answer\'s truncation from its data, and refuses a 2xx body that is not JSON', async () => {
    const responses = [
      new Response(JSON.stringify({ success: true, data: { found: false, nodes: [], truncated: true }, meta: { found: false } }), { status: 200 }),
      new Response('<html>proxy error</html>', { status: 200 }),
    ];
    const fetchImpl = (async () => responses.shift() as Response) as unknown as typeof fetch;
    const [path, broken] = await runQueries(
      [
        { kind: 'path', method: 'POST', path: '/p', body: {}, key: 'from=a', params: {} },
        { kind: 'search', method: 'GET', path: '/s', key: 'q=x', params: {} },
      ],
      { baseUrl: 'http://bench', repositoryId: 'r', projectId: 'p', iterations: 1, fetchImpl },
    );

    expect(path).toMatchObject({ ok: true, truncated: true });
    expect(broken).toMatchObject({ ok: false, status: 200, error: 'unparseable response body (HTTP 200)' });
  });

  it('records warm-up passes but never summarises them', async () => {
    let clock = 0;
    const fetchImpl = (async () => {
      clock += 5;
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'server-timing': 'app;dur=1' } });
    }) as unknown as typeof fetch;
    const records = await runQueries([{ kind: 'search', method: 'GET', path: '/a', key: 'q=x', params: { q: 'x' } }], {
      baseUrl: 'http://bench', repositoryId: 'r', projectId: 'p', warmupPasses: 2, iterations: 3, round: 1, fetchImpl, now: () => clock,
    });

    expect(records.map((record) => record.warmup)).toEqual([true, true, false, false, false]);
    expect(summarizeQueries(records)[0]?.pooled.count).toBe(3);
  });

  it('summarises each round and reports the round-to-round ratio as the noise floor', () => {
    const base = {
      repositoryId: 'r', projectId: 'p', kind: 'traverse' as const, key: 'depth=1', params: {}, warmup: false,
      at: '2026-10-12T00:00:00.000Z', status: 200, ok: true, clientMs: 1, resultCount: 3, truncated: false, responseBytes: 10, error: null,
    };
    const records: QueryRecord[] = [
      ...[10, 10, 10].map((serverMs, iteration) => ({ ...base, round: 1, iteration, serverMs })),
      ...[11, 11, 11].map((serverMs, iteration) => ({ ...base, round: 2, iteration, serverMs })),
      { ...base, round: 1, iteration: 3, serverMs: null, ok: false, status: 500, error: 'boom' },
    ];
    const [entry] = summarizeQueries(records);

    expect(entry?.rounds.map((round) => [round.round, round.count, round.failed, round.serverMs.median])).toEqual([
      [1, 4, 1, 10],
      [2, 3, 0, 11],
    ]);
    expect(entry?.roundToRoundRatio).toBeCloseTo(1.1);
    expect(entry?.pooled).toMatchObject({ count: 7, failed: 1 });
  });
});

describe('environment capture', () => {
  it('records machine and tools, and null for a tool that does not answer', async () => {
    const environment = await captureEnvironment({
      workspaceRoot: '/repo',
      scipExecutable: null,
      postgresVersion: '17.2',
      treeFingerprint: 'a'.repeat(64),
      probe: async (command, args) => {
        if (command === 'pnpm') return '11.11.0';
        if (args[0] === 'rev-parse') return 'f'.repeat(40);
        if (args[0] === 'status') return ' M src/a.ts';
        return null;
      },
    });

    expect(environment.machine.cores).toBeGreaterThan(0);
    expect(environment.machine.memoryBytes).toBeGreaterThan(0);
    expect(environment.tools).toMatchObject({ node: process.version, pnpm: '11.11.0', git: null, scipTypescript: null, postgres: '17.2' });
    expect(environment.toolCommit).toEqual({ sha: 'f'.repeat(40), dirty: true, treeFingerprint: 'a'.repeat(64) });
  });
});
