import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AnalysisJob,
  CodeNode,
  CodeSearchMatch,
  GraphPath,
  NodeDetail,
  ProjectSummary,
} from '../src/types/index.js';
import type { CodeSearchMeta } from '../src/api/code-search.api.js';
import { searchCode } from '../src/api/code-search.api.js';
import { fetchNodeDetail, findPath, searchNodes } from '../src/api/graph.api.js';
import { fetchSource } from '../src/api/source.api.js';
import {
  codeSearchSummary,
  codeSearchWarnings,
  evidenceLocation,
  graphRetrievalEnabled,
  indexCaveat,
  matchKey,
  matchSegments,
  groupMatchesByFile,
  splitPath,
  projectOptions,
  readIndexStatus,
  relationshipSections,
  sourceRangeAround,
  traceVerdict,
  formatCall,
  callStatusLabel,
} from '../src/features/retrieval/model/retrieval.js';

/**
 * The Retrieval Lab, at the two seams that can be checked without a browser:
 * the decisions, and the requests they turn into.
 *
 * Same arrangement as the explorer's suite, for the same reason — the page's
 * judgements are pure functions precisely so they can be checked exhaustively,
 * including the cases a real project makes awkward to arrange (a truncated
 * scan, a failed run over a graph that is still there).
 *
 * The judgements that matter most are the ones about *incompleteness*. This
 * page exists to validate retrieval, so a label that rounded off a caveat would
 * teach the wrong lesson about what the backend actually said.
 */

// --- fixtures --------------------------------------------------------------

function run(overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: 'a1',
    projectId: 'p1',
    repositoryId: 'r1',
    status: 'COMPLETED',
    language: 'typescript',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    error: null,
    stats: { documentCount: 6, symbolCount: 120, nodeCount: 79, edgeCount: 247, durationMs: 6000 },
    progress: null,
    errors: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function meta(overrides: Partial<CodeSearchMeta> = {}): CodeSearchMeta {
  return {
    total: 8,
    limit: 20,
    truncated: false,
    filesSearched: 19,
    filesSkipped: 0,
    scanTruncated: false,
    ...overrides,
  };
}

function match(overrides: Partial<CodeSearchMatch> = {}): CodeSearchMatch {
  return {
    filePath: 'src/repositories/user.repository.ts',
    line: 8,
    column: 7,
    match: 'UserRepository',
    lineText: 'export class UserRepository {',
    lineTruncated: false,
    ...overrides,
  };
}

interface Captured {
  url: string;
  method: string;
  body?: unknown;
}

function stubApi(data: unknown, responseMeta: Record<string, unknown> = {}): Captured[] {
  const calls: Captured[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });

      return new Response(
        JSON.stringify({ success: true, data, error: null, meta: responseMeta }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );

  return calls;
}

function stubFailure(status: number, code: string, message: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, data: null, error: { code, message }, meta: {} }),
          { status, headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- project selection -----------------------------------------------------

describe('project selection', () => {
  it('leads with the name and disambiguates by path', () => {
    const projects = [
      {
        id: 'p1',
        name: 'ts-sample',
        repository: { sourceType: 'local', sourcePath: '/srv/a', commitHash: null },
      },
      { id: 'p2', name: 'no-repo', repository: null },
    ] as ProjectSummary[];

    expect(projectOptions(projects)).toEqual([
      { id: 'p1', label: 'ts-sample', detail: '/srv/a' },
      { id: 'p2', label: 'no-repo', detail: null },
    ]);
  });
});

// --- index status ----------------------------------------------------------

describe('index status', () => {
  it('reads a completed run as ready and usable', () => {
    const status = readIndexStatus([run()]);

    expect(status).toMatchObject({ state: 'ready', usable: true, nodeCount: 79, edgeCount: 247 });
    expect(indexCaveat(status)).toBeNull();
    expect(graphRetrievalEnabled(status)).toBe(true);
  });

  it('reads no runs at all as never indexed', () => {
    const status = readIndexStatus([]);

    expect(status).toMatchObject({ state: 'never_indexed', usable: false, latest: null });
    expect(indexCaveat(status)).toMatch(/never been indexed/);
    expect(graphRetrievalEnabled(status)).toBe(false);
  });

  it('keeps a failed run usable when an earlier one succeeded', () => {
    // The pipeline replaces a graph in one step at the end of a run, so a
    // failed re-index leaves the previous graph exactly where it was.
    const status = readIndexStatus([
      run({ id: 'a2', status: 'FAILED', stats: null, error: 'SCIP_INDEX_FAILED' }),
      run({ id: 'a1' }),
    ]);

    expect(status).toMatchObject({ state: 'failed', usable: true });
    expect(status.lastSuccessful?.id).toBe('a1');
    expect(indexCaveat(status)).toMatch(/earlier graph is still stored/);
    expect(graphRetrievalEnabled(status)).toBe(true);
  });

  it('reports a failed first run as unusable', () => {
    const status = readIndexStatus([run({ status: 'FAILED', stats: null })]);

    expect(status).toMatchObject({ state: 'failed', usable: false, lastSuccessful: null });
    expect(indexCaveat(status)).toMatch(/no graph was ever stored/);
    expect(graphRetrievalEnabled(status)).toBe(false);
  });

  it('reads an in-flight run as indexing', () => {
    expect(readIndexStatus([run({ status: 'PARSING', stats: null })])).toMatchObject({
      state: 'indexing',
      usable: false,
    });
  });

  it('counts the files a run could not read', () => {
    const status = readIndexStatus([
      run({ errors: [{ file: 'a.ts', error: 'too large' }, { file: 'b.ts', error: 'parse' }] }),
    ]);

    expect(status.warningCount).toBe(2);
  });
});

// --- code search -----------------------------------------------------------

describe('code search results', () => {
  it('states a complete count plainly', () => {
    expect(codeSearchSummary(meta({ total: 8 }), 8)).toBe('8 matches');
    expect(codeSearchSummary(meta({ total: 1 }), 1)).toBe('1 match');
  });

  it('says "of" only when the search actually finished', () => {
    expect(codeSearchSummary(meta({ total: 53, truncated: true }), 20)).toBe(
      'Showing 20 of 53 matches',
    );
  });

  it('never claims a total when the scan was truncated', () => {
    // `total` is a floor here, and the shortfall is unknown — "of 53" would be
    // a statement about a search that did not finish.
    const label = codeSearchSummary(meta({ total: 53, truncated: true, scanTruncated: true }), 20);

    expect(label).toBe('Showing 20 matches — at least 53 exist');
    expect(label).not.toMatch(/of 53/);
  });

  it('warns about an incomplete walk, with the file count', () => {
    const [warning] = codeSearchWarnings(meta({ scanTruncated: true, filesSearched: 25_000 }));

    expect(warning?.title).toBe('Repository scan incomplete');
    expect(warning?.body).toMatch(/25000 files searched/);
    expect(warning?.body).toMatch(/floor rather than a total/);
  });

  it('warns about skipped files, pluralised', () => {
    expect(codeSearchWarnings(meta({ filesSkipped: 1 }))[0]?.title).toBe('1 file skipped');
    expect(codeSearchWarnings(meta({ filesSkipped: 3 }))[0]?.title).toBe('3 files skipped');
  });

  it('says nothing when the search was complete', () => {
    expect(codeSearchWarnings(meta())).toEqual([]);
  });

  it('keys a match by its full position, since occurrences share a line', () => {
    expect(matchKey(match())).toBe('src/repositories/user.repository.ts:8:7');
    expect(matchKey(match({ column: 20 }))).not.toBe(matchKey(match()));
  });

  it('lights the run the API reported, at the column it reported', () => {
    expect(matchSegments(match())).toEqual([
      { text: 'export class ', hit: false },
      { text: 'UserRepository', hit: true },
      { text: ' {', hit: false },
    ]);
  });

  it('lights every occurrence on the line, since each one is a result', () => {
    const segments = matchSegments(
      match({ match: 'user', column: 6, lineText: 'const user = user.id;' }),
    );

    expect(segments.filter((segment) => segment.hit)).toHaveLength(2);
    expect(segments.map((segment) => segment.text).join('')).toBe('const user = user.id;');
  });

  it('finds the run itself when the column indexes a line that was windowed', () => {
    // `column` counts from the start of the whole line; `lineText` is a window
    // of it, so the offset cannot be trusted and the text has to be searched.
    expect(
      matchSegments(
        match({ column: 4_000, lineText: 'x = UserRepository;', lineTruncated: true }),
      ),
    ).toEqual([
      { text: 'x = ', hit: false },
      { text: 'UserRepository', hit: true },
      { text: ';', hit: false },
    ]);
  });

  it('lights nothing rather than the wrong thing when the run is not in the window', () => {
    expect(
      matchSegments(match({ column: 4_000, lineText: 'nothing here', lineTruncated: true })),
    ).toEqual([{ text: 'nothing here', hit: false }]);
  });

  it('gathers occurrences under their file, in the order the API returned them', () => {
    const groups = groupMatchesByFile([
      match({ filePath: 'a.ts', line: 1 }),
      match({ filePath: 'a.ts', line: 9 }),
      match({ filePath: 'b.ts', line: 2 }),
    ]);

    expect(groups.map((group) => group.filePath)).toEqual(['a.ts', 'b.ts']);
    expect(groups[0]?.matches).toHaveLength(2);
    expect(groups[1]?.matches).toHaveLength(1);
  });

  it('splits a path so the name survives a narrow column', () => {
    expect(splitPath('src/api/user.routes.ts')).toEqual({
      directory: 'src/api/',
      name: 'user.routes.ts',
    });
    expect(splitPath('README.md')).toEqual({ directory: '', name: 'README.md' });
  });
});

// --- source window ---------------------------------------------------------

describe('source window', () => {
  it('centres a bounded range on the matched line', () => {
    expect(sourceRangeAround(8)).toEqual({ startLine: 2, endLine: 14 });
  });

  it('never asks for a line before the first', () => {
    expect(sourceRangeAround(2)).toEqual({ startLine: 1, endLine: 8 });
  });
});

// --- node relationships ----------------------------------------------------

describe('node relationships', () => {
  const empty = {
    callers: [],
    callees: [],
    references: [],
    dependencies: [],
    dependents: [],
    apis: [],
    databases: [],
    documentation: [],
    contracts: [],
    implementations: [],
    children: [],
  };

  it('shows only the sections that have something in them', () => {
    const detail = {
      ...empty,
      callers: [{ id: 'c1', name: 'UserService' } as CodeNode],
      databases: [{ id: 't1', name: 'users', relationship: 'WRITES_TO' }],
    } as unknown as NodeDetail;

    expect(relationshipSections(detail).map((section) => section.key)).toEqual([
      'callers',
      'databases',
    ]);
  });

  it('shows nothing for a node with no relationships', () => {
    expect(relationshipSections(empty as unknown as NodeDetail)).toEqual([]);
  });

  it('reports a line without a file as a line', () => {
    // Real analyzers do this: the file is implied by the node being read.
    expect(evidenceLocation({ line: 38 })).toBe('line 38');
    expect(evidenceLocation({ file: 'a.ts', line: 38 })).toBe('a.ts:38');
    expect(evidenceLocation({ file: 'a.ts' })).toBe('a.ts');
    expect(evidenceLocation(null)).toBeNull();
  });
});

// --- trace verdicts --------------------------------------------------------

describe('trace verdicts', () => {
  const path = (overrides: Partial<GraphPath>): GraphPath =>
    ({
      found: true,
      from: 'a',
      to: 'c',
      depth: 2,
      undirected: false,
      truncated: false,
      nodes: [],
      edges: [],
      steps: [],
      relationships: ['CALLS'],
      ...overrides,
    }) as GraphPath;

  it('reports a route that was found', () => {
    expect(traceVerdict(path({}), 6)).toMatchObject({ outcome: 'found', title: 'Path found' });
  });

  it('explains an undirected route rather than presenting it as a flow', () => {
    expect(traceVerdict(path({ undirected: true }), 6).body).toMatch(/ignores edge direction/);
  });

  it('names the depth a no-path answer is a statement about', () => {
    const verdict = traceVerdict(path({ found: false, depth: 0 }), 3);

    expect(verdict.outcome).toBe('none');
    expect(verdict.title).toBe('No path found within 3 hops');
  });

  it('never calls an exhausted search a missing path', () => {
    const verdict = traceVerdict(path({ found: false, truncated: true }), 6);

    expect(verdict.outcome).toBe('inconclusive');
    expect(verdict.title).toMatch(/truncated/);
    expect(verdict.title).not.toMatch(/No path/);
    expect(verdict.body).toMatch(/does not mean no route exists/);
  });

  it('names a node traced to itself', () => {
    expect(traceVerdict(path({ depth: 0 }), 6).title).toBe('Same node');
  });
});

// --- request inspector -----------------------------------------------------

describe('request inspector', () => {
  it('breaks a query string onto readable lines', () => {
    expect(
      formatCall({
        method: 'GET',
        url: '/api/projects/p1/code/search?q=UserRepository&limit=20',
        status: 200,
        durationMs: 154,
        error: null,
      }),
    ).toEqual(['GET /api/projects/p1/code/search', '  ?q=UserRepository', '  &limit=20']);
  });

  it('shows a POST body', () => {
    const lines = formatCall({
      method: 'POST',
      url: '/api/projects/p1/graph/path',
      body: { from: 'a', to: 'c', maxDepth: 6 },
      status: 200,
      durationMs: 12,
      error: null,
    });

    expect(lines[1]).toBe('  {"from":"a","to":"c","maxDepth":6}');
  });

  it('shows status and timing, or the failure', () => {
    expect(
      callStatusLabel({ method: 'GET', url: '/x', status: 200, durationMs: 153.7, error: null }),
    ).toBe('200 · 154 ms');
    expect(
      callStatusLabel({ method: 'GET', url: '/x', status: 404, durationMs: 4, error: 'Not found' }),
    ).toBe('Not found');
  });
});

// --- the requests these decisions produce ----------------------------------

describe('retrieval requests', () => {
  it('sends the code query untouched, with the limit', async () => {
    const calls = stubApi([match()], { total: 8, limit: 20, truncated: false });

    // Mixed case and surrounding spaces are part of a literal term.
    await searchCode('p1', '  UserRepository  ', { limit: 20 });

    const url = new URL(calls[0]?.url ?? '', 'http://localhost');
    expect(url.pathname).toBe('/api/projects/p1/code/search');
    expect(url.searchParams.get('q')).toBe('  UserRepository  ');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('reads the count metadata the route reports', async () => {
    stubApi([match()], {
      total: 53,
      limit: 20,
      truncated: true,
      filesSearched: 749,
      filesSkipped: 2,
      scanTruncated: true,
    });

    const page = await searchCode('p1', 'x');

    expect(page.meta).toEqual({
      total: 53,
      limit: 20,
      truncated: true,
      filesSearched: 749,
      filesSkipped: 2,
      scanTruncated: true,
    });
  });

  it('falls back to what it can see when the route reports no metadata', async () => {
    stubApi([match(), match({ column: 20 })], {});

    expect((await searchCode('p1', 'x')).meta).toMatchObject({
      total: 2,
      truncated: false,
      scanTruncated: false,
    });
  });

  it('requests a bounded source window around the selected match', async () => {
    const calls = stubApi({
      file: 'src/a.ts',
      language: 'typescript',
      startLine: 2,
      endLine: 14,
      totalLines: 55,
      truncated: false,
      highlight: null,
      lines: [],
    });

    const range = sourceRangeAround(match().line);
    await fetchSource('p1', { file: match().filePath, ...range });

    const url = new URL(calls[0]?.url ?? '', 'http://localhost');
    expect(url.pathname).toBe('/api/projects/p1/source');
    expect(url.searchParams.get('file')).toBe('src/repositories/user.repository.ts');
    expect(url.searchParams.get('startLine')).toBe('2');
    expect(url.searchParams.get('endLine')).toBe('14');
  });

  it('scopes graph search to the project in the path', async () => {
    const calls = stubApi([], { total: 0 });

    await searchNodes('p1', 'UserRepository', { limit: 20 });

    const url = new URL(calls[0]?.url ?? '', 'http://localhost');
    expect(url.pathname).toBe('/api/projects/p1/graph/search');
    expect(url.searchParams.get('q')).toBe('UserRepository');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('addresses node detail by project and node', async () => {
    const calls = stubApi({ node: { id: 'n1' } });

    await fetchNodeDetail('p1', 'node/with slash');

    expect(calls[0]?.url).toBe('/api/projects/p1/graph/nodes/node%2Fwith%20slash');
  });

  it('sends the path request with the API’s own field names', async () => {
    const calls = stubApi({ found: false });

    await findPath('p1', { from: 'a', to: 'c', maxDepth: 6 });

    expect(calls[0]).toMatchObject({
      url: '/api/projects/p1/graph/path',
      method: 'POST',
      // `from`/`to`, never `fromNodeId`/`toNodeId`.
      body: { from: 'a', to: 'c', maxDepth: 6 },
    });
  });

  it('surfaces the API’s stable code on a failure', async () => {
    stubFailure(404, 'SOURCE_FILE_NOT_FOUND', 'src/gone.ts was not found');

    await expect(fetchSource('p1', { file: 'src/gone.ts' })).rejects.toMatchObject({
      code: 'SOURCE_FILE_NOT_FOUND',
      status: 404,
    });
  });

  it('surfaces a refused path as the API described it', async () => {
    stubFailure(403, 'SOURCE_PATH_NOT_ALLOWED', 'A source path must not climb above the root');

    await expect(fetchSource('p1', { file: '../../etc/passwd' })).rejects.toMatchObject({
      code: 'SOURCE_PATH_NOT_ALLOWED',
    });
  });

  it('surfaces a network failure as a reachable error rather than a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(searchCode('p1', 'x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('surfaces a malformed response rather than returning nonsense', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>not the api</html>', { status: 200 }),
      ),
    );

    await expect(searchCode('p1', 'x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

// --- the whole workflow, as requests ---------------------------------------

describe('the investigation workflow', () => {
  it('carries the project and the selection from one step to the next', async () => {
    const projectId = 'p1';
    const calls: Captured[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({
          url,
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        });

        const data = url.includes('/code/search')
          ? [match()]
          : url.includes('/source')
            ? { file: 'x', language: null, startLine: 1, endLine: 1, totalLines: 1, truncated: false, highlight: null, lines: [] }
            : url.includes('/graph/search')
              ? [{ id: 'node-1', name: 'UserRepository' } as CodeNode]
              : url.includes('/graph/path')
                ? { found: true }
                : { node: { id: 'node-1' } };

        return new Response(JSON.stringify({ success: true, data, error: null, meta: { total: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    // 1. search code, 2. select the hit and read source around it …
    const page = await searchCode(projectId, 'UserRepository', { limit: 20 });
    const hit = page.matches[0] as CodeSearchMatch;
    await fetchSource(projectId, { file: hit.filePath, ...sourceRangeAround(hit.line) });

    // … 3. find the node by name, 4. inspect it, 5. trace from it.
    const found = await searchNodes(projectId, 'UserRepository', { limit: 20 });
    const node = found.nodes[0] as CodeNode;
    await fetchNodeDetail(projectId, node.id);
    await findPath(projectId, { from: node.id, to: 'node-2', maxDepth: 6 });

    // Every request is scoped to the one project, and nothing was copied by
    // hand: each step's input came from the previous step's output.
    expect(calls).toHaveLength(5);
    for (const call of calls) expect(call.url).toContain(`/api/projects/${projectId}/`);

    expect(calls[1]?.url).toContain(encodeURIComponent(hit.filePath));
    expect(calls[1]?.url).toContain('startLine=2');
    expect(calls[3]?.url).toContain('/graph/nodes/node-1');
    expect(calls[4]?.body).toMatchObject({ from: 'node-1', to: 'node-2' });
  });
});
