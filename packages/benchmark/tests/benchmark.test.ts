import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CodeGraph } from '@ckg/shared';
import { evaluate, type EvaluationResult } from '../src/evaluate.js';
import { GROUND_TRUTH_DIR, GroundTruthError, loadGroundTruth } from '../src/ground-truth.js';
import { BENCHMARK_FIXTURES } from '../src/graph-source.js';
import { toMachineReport, formatReport } from '../src/report.js';
import { runBenchmark, type BenchmarkRun } from '../src/run.js';

/**
 * The benchmark, run for real.
 *
 * Two things are being tested and they are different. The first is that the
 * *evaluator* is right — that it detects a missing node, an extra one, a wrong
 * confidence and a broken path — which is checked against small synthetic
 * graphs where the answer is obvious. The second is that the *pipeline* meets
 * its ground truth, which is the benchmark itself.
 *
 * The second is deliberately not asserted as a fixed percentage. A benchmark
 * whose test says "recall is 97.4%" has to be edited every time the pipeline
 * improves, and the number in the assertion stops being a measurement and
 * becomes a decoration. What is asserted is that every expectation in the
 * dataset holds, which is a statement about the repository rather than about a
 * number.
 */

describe('ground truth loading', () => {
  it('loads the bundled dataset and validates every term against the vocabulary', async () => {
    const truth = await loadGroundTruth('repository-knowledge-sample');

    expect(truth.fixture).toBe('repository-knowledge-sample');
    expect(truth.nodes.length).toBeGreaterThan(50);
    expect(truth.edges.length).toBeGreaterThan(40);
    expect(truth.paths.length).toBeGreaterThan(0);
    expect(truth.closedNodeTypes).toContain('api_endpoint');
    expect(truth.closedRelationships).toContain('IMPLEMENTED_BY');
  });

  it('has a dataset for every fixture the benchmark runs', async () => {
    for (const fixture of BENCHMARK_FIXTURES) {
      await expect(loadGroundTruth(fixture.name, GROUND_TRUTH_DIR)).resolves.toBeTruthy();
    }
  });

  describe('rejects a broken dataset rather than blaming the pipeline', () => {
    const write = async (files: Record<string, unknown>): Promise<string> => {
      const root = await mkdtemp(path.join(tmpdir(), 'ckg-truth-'));
      await mkdir(path.join(root, 'sample'), { recursive: true });
      for (const [name, body] of Object.entries(files)) {
        await writeFile(path.join(root, 'sample', name), JSON.stringify(body), 'utf8');
      }
      return root;
    };

    const valid = {
      'nodes.json': { fixture: 'sample', closedTypes: [], nodes: [] },
      'edges.json': { closedRelationships: [], edges: [] },
      'paths.json': { paths: [] },
    };

    it('a node type that is not in the vocabulary', async () => {
      const root = await write({
        ...valid,
        'nodes.json': { fixture: 'sample', closedTypes: [], nodes: [{ type: 'clazz', name: 'X' }] },
      });
      await expect(loadGroundTruth('sample', root)).rejects.toThrow(GroundTruthError);
    });

    it('a relationship that is not in the vocabulary', async () => {
      const root = await write({
        ...valid,
        'edges.json': {
          closedRelationships: [],
          edges: [
            { from: { type: 'class', name: 'A' }, relationship: 'POKES', to: { type: 'class', name: 'B' } },
          ],
        },
      });
      await expect(loadGroundTruth('sample', root)).rejects.toThrow(/POKES|one of/);
    });

    it('the same expectation written twice, which would double-count recall', async () => {
      const root = await write({
        ...valid,
        'nodes.json': {
          fixture: 'sample',
          closedTypes: [],
          nodes: [
            { type: 'class', name: 'X' },
            { type: 'class', name: 'X' },
          ],
        },
      });
      await expect(loadGroundTruth('sample', root)).rejects.toThrow(/twice/);
    });

    it('a dataset that names a different fixture than it was loaded as', async () => {
      const root = await write({
        ...valid,
        'nodes.json': { fixture: 'other', closedTypes: [], nodes: [] },
      });
      await expect(loadGroundTruth('sample', root)).rejects.toThrow(/declares fixture/);
    });

    it('a count that is not a positive integer', async () => {
      const root = await write({
        ...valid,
        'nodes.json': { fixture: 'sample', closedTypes: [], nodes: [{ type: 'class', name: 'X', count: 0 }] },
      });
      await expect(loadGroundTruth('sample', root)).rejects.toThrow(/positive integer/);
    });

    it('a known false positive in an open category, where it could never be counted', async () => {
      const root = await write({
        ...valid,
        'edges.json': {
          closedRelationships: [],
          edges: [],
          knownFalsePositives: [
            { from: { type: 'class', name: 'A' }, relationship: 'CALLS', to: { type: 'class', name: 'B' }, reason: 'r' },
          ],
        },
      });
      await expect(loadGroundTruth('sample', root)).rejects.toThrow(/not a closed relationship/);
    });

    it('the same edge listed as expected and as a known false positive', async () => {
      const both = { from: { type: 'class', name: 'A' }, relationship: 'CALLS', to: { type: 'class', name: 'B' } };
      const root = await write({
        ...valid,
        'edges.json': {
          closedRelationships: ['CALLS'],
          edges: [both],
          knownFalsePositives: [{ ...both, reason: 'r' }],
        },
      });
      await expect(loadGroundTruth('sample', root)).rejects.toThrow(/both as expected and as a known false positive/);
    });

    it('a diagnostics expectation of the wrong type', async () => {
      const root = await write({
        ...valid,
        'nodes.json': { fixture: 'sample', closedTypes: [], nodes: [], diagnostics: { truncated: 'no' } },
      });
      await expect(loadGroundTruth('sample', root)).rejects.toThrow(/truncated must be a boolean/);
    });

    it('a missing file', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'ckg-truth-'));
      await expect(loadGroundTruth('sample', root)).rejects.toThrow(/missing/);
    });
  });
});

describe('the evaluator', () => {
  const node = (id: string, type: string, name: string): CodeGraph['nodes'][number] =>
    ({ id, projectId: 'p', type, name } as CodeGraph['nodes'][number]);

  const edge = (
    id: string,
    from: string,
    relationship: string,
    to: string,
    metadata?: Record<string, unknown>,
  ): CodeGraph['edges'][number] =>
    ({
      id,
      projectId: 'p',
      sourceNodeId: from,
      targetNodeId: to,
      relationship,
      metadata,
    }) as CodeGraph['edges'][number];

  const truth = {
    fixture: 'synthetic',
    closedNodeTypes: ['table'] as never,
    nodes: [
      { type: 'table', name: 'users' },
      { type: 'class', name: 'UserRepository' },
    ] as never,
    closedRelationships: ['WRITES_TO'] as never,
    edges: [
      {
        from: { type: 'class', name: 'UserRepository' },
        relationship: 'WRITES_TO',
        to: { type: 'table', name: 'users' },
        confidence: 'high',
      },
    ] as never,
    paths: [] as never,
  };

  const complete: CodeGraph = {
    nodes: [node('t', 'table', 'users'), node('c', 'class', 'UserRepository')],
    edges: [
      edge('e', 'c', 'WRITES_TO', 't', {
        source: 'database-analyzer',
        confidence: 'high',
        method: 'ast',
        file: 'a.ts',
        line: 3,
      }),
    ],
  };

  it('passes a graph that matches', () => {
    const result = evaluate(complete, truth);

    expect(result.passed).toBe(true);
    expect(result.nodes.recall).toBe(1);
    expect(result.edges.precision).toBe(1);
    expect(result.evidence.invalid).toBe(0);
    expect(result.evidence.located).toBe(1);
  });

  it('counts a missing node as a recall failure and names it', () => {
    const result = evaluate({ ...complete, nodes: [complete.nodes[1] as never] }, truth);

    expect(result.passed).toBe(false);
    expect(result.nodeCategories.find((entry) => entry.category === 'table')?.missing).toEqual([
      'table|users',
    ]);
    expect(result.nodes.recall).toBeCloseTo(0.5);
  });

  it('counts an extra node in a closed category as a precision failure', () => {
    const result = evaluate(
      { ...complete, nodes: [...complete.nodes, node('t2', 'table', 'ghosts')] },
      truth,
    );

    const table = result.nodeCategories.find((entry) => entry.category === 'table');
    expect(table?.unexpected).toEqual(['ghosts']);
    expect(table?.score.precision).toBeCloseTo(0.5);
    expect(result.passed).toBe(false);
  });

  it('ignores an extra node in an open category', () => {
    const result = evaluate(
      { ...complete, nodes: [...complete.nodes, node('c2', 'class', 'Unlisted')] },
      truth,
    );

    expect(result.nodeCategories.find((entry) => entry.category === 'class')?.unexpected).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('catches a confidence that disagrees with the policy', () => {
    const result = evaluate(
      {
        ...complete,
        edges: [
          edge('e', 'c', 'WRITES_TO', 't', { source: 'database-analyzer', confidence: 'medium' }),
        ],
      },
      truth,
    );

    expect(result.evidence.confidenceMismatches[0]?.reason).toContain('expected confidence high');
    expect(result.passed).toBe(false);
  });

  it('catches an edge with no evidence at all', () => {
    const result = evaluate(
      { ...complete, edges: [edge('e', 'c', 'WRITES_TO', 't')] },
      truth,
    );

    expect(result.evidence.invalid).toBe(1);
    expect(result.evidence.unattributed).toHaveLength(1);
    expect(result.passed).toBe(false);
  });

  it('excludes a compiler fact from the "carries a line" denominator', () => {
    const result = evaluate(
      {
        ...complete,
        edges: [
          edge('e', 'c', 'WRITES_TO', 't', {
            source: 'scip',
            confidence: 'high',
            method: 'scip',
          }),
        ],
      },
      { ...truth, edges: [] as never },
    );

    // A SCIP edge is located by its endpoints; demanding a line would be
    // demanding something the index never reported.
    expect(result.evidence.locatable).toBe(0);
    expect(result.evidence.valid).toBe(1);
  });

  it('reports a path that does not exist, rather than failing silently', () => {
    const result = evaluate(complete, {
      ...truth,
      paths: [
        {
          name: 'nowhere',
          from: { type: 'table', name: 'users' },
          to: { type: 'class', name: 'UserRepository' },
          maxDepth: 3,
        },
      ] as never,
    });

    // The edge runs class -> table; the trace asks for the other direction.
    expect(result.paths[0]?.found).toBe(false);
    expect(result.paths[0]?.problems[0]).toContain('no directed route');
    expect(result.passed).toBe(false);
  });

  it('constrains the search to the relationships an expectation names', () => {
    const graph: CodeGraph = {
      nodes: [...complete.nodes, node('x', 'class', 'Other')],
      edges: [
        ...complete.edges,
        edge('e2', 'c', 'CALLS', 'x', { source: 'scip', confidence: 'high', method: 'scip' }),
      ],
    };

    const viaCalls = evaluate(graph, {
      ...truth,
      paths: [
        {
          name: 'by calls only',
          from: { type: 'class', name: 'UserRepository' },
          to: { type: 'table', name: 'users' },
          maxDepth: 3,
          viaRelationships: ['CALLS'],
        },
      ] as never,
    });
    expect(viaCalls.paths[0]?.found).toBe(false);

    const viaWrites = evaluate(graph, {
      ...truth,
      paths: [
        {
          name: 'by writes',
          from: { type: 'class', name: 'UserRepository' },
          to: { type: 'table', name: 'users' },
          maxDepth: 3,
          viaRelationships: ['WRITES_TO'],
        },
      ] as never,
    });
    expect(viaWrites.paths[0]).toMatchObject({ found: true, depth: 1 });
  });

  it('checks that a route passes through the nodes it is supposed to', () => {
    const graph: CodeGraph = {
      nodes: [...complete.nodes, node('m', 'method', 'UserRepository.create')],
      edges: [
        edge('e1', 'c', 'CONTAINS', 'm', { source: 'scip', confidence: 'high', method: 'scip' }),
        edge('e2', 'm', 'WRITES_TO', 't', {
          source: 'database-analyzer',
          confidence: 'high',
          method: 'ast',
          file: 'a.ts',
          line: 1,
        }),
      ],
    };

    const withStep = evaluate(graph, {
      ...truth,
      edges: [] as never,
      paths: [
        {
          name: 'through the method',
          from: { type: 'class', name: 'UserRepository' },
          to: { type: 'table', name: 'users' },
          maxDepth: 4,
          through: [{ type: 'method', name: 'UserRepository.create' }],
        },
      ] as never,
    });
    expect(withStep.paths[0]).toMatchObject({ found: true, problems: [] });

    const wrongStep = evaluate(graph, {
      ...truth,
      edges: [] as never,
      paths: [
        {
          name: 'through something else',
          from: { type: 'class', name: 'UserRepository' },
          to: { type: 'table', name: 'users' },
          maxDepth: 4,
          through: [{ type: 'method', name: 'Nope.nope' }],
        },
      ] as never,
    });
    expect(wrongStep.paths[0]?.problems[0]).toContain('did not pass through');
  });

  describe('closed categories count every produced item once', () => {
    const scip = { source: 'scip', confidence: 'high', method: 'scip' };
    const callsTruth = (edges: unknown[], extra: Record<string, unknown> = {}) =>
      ({
        fixture: 'synthetic',
        closedNodeTypes: [] as never,
        nodes: [] as never,
        closedRelationships: ['CALLS'] as never,
        edges: edges as never,
        paths: [] as never,
        ...extra,
      }) as Parameters<typeof evaluate>[1];
    const call = (from: string, to: string) => ({
      from: { type: 'function', name: from },
      relationship: 'CALLS',
      to: { type: 'function', name: to },
    });
    const functions = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => node(name, 'function', name));

    it('computes precision, recall and F1 from counts worked out by hand', () => {
      // Expected: a->b, a->c, a->d, a->e. Produced: a->b, a->c, a->d, b->c, b->d.
      // TP 3, FP 2, FN 1: precision 3/5, recall 3/4, F1 2PR/(P+R) = 2/3.
      const graph: CodeGraph = {
        nodes: functions,
        edges: [
          edge('1', 'a', 'CALLS', 'b', scip),
          edge('2', 'a', 'CALLS', 'c', scip),
          edge('3', 'a', 'CALLS', 'd', scip),
          edge('4', 'b', 'CALLS', 'c', scip),
          edge('5', 'b', 'CALLS', 'd', scip),
        ],
      };
      const result = evaluate(graph, callsTruth([call('a', 'b'), call('a', 'c'), call('a', 'd'), call('a', 'e')]));
      const score = result.edgeCategories.find((entry) => entry.category === 'CALLS')?.score;

      expect(score).toMatchObject({ truePositives: 3, falsePositives: 2, falseNegatives: 1, produced: 5 });
      expect(score?.precision).toBeCloseTo(0.6);
      expect(score?.recall).toBeCloseTo(0.75);
      expect(score?.f1).toBeCloseTo(2 / 3);
    });

    it('counts a duplicate node in a closed category as a false positive rather than collapsing it', () => {
      const result = evaluate(
        { nodes: [node('t', 'table', 'users'), node('t2', 'table', 'users'), complete.nodes[1] as never], edges: complete.edges },
        truth,
      );
      const table = result.nodeCategories.find((entry) => entry.category === 'table');

      expect(table?.score).toMatchObject({ truePositives: 1, falsePositives: 1, produced: 2 });
      expect(table?.score.precision).toBeCloseTo(0.5);
      expect(table?.unexpected).toEqual(['users']);
      expect(result.passed).toBe(false);
    });

    it('accepts several nodes at one address when the ground truth says how many', () => {
      const result = evaluate(
        { nodes: [node('t', 'table', 'users'), node('t2', 'table', 'users'), complete.nodes[1] as never], edges: complete.edges },
        { ...truth, nodes: [{ type: 'table', name: 'users', count: 2 }, { type: 'class', name: 'UserRepository' }] as never },
      );

      expect(result.nodeCategories.find((entry) => entry.category === 'table')?.score).toMatchObject({
        truePositives: 2,
        falsePositives: 0,
        falseNegatives: 0,
      });
      expect(result.passed).toBe(true);
    });

    it('reports a partly met count as missing, with how many were found', () => {
      const result = evaluate(complete, {
        ...truth,
        nodes: [{ type: 'table', name: 'users', count: 2 }, { type: 'class', name: 'UserRepository' }] as never,
      });
      const table = result.nodeCategories.find((entry) => entry.category === 'table');

      expect(table?.missing).toEqual(['table|users (1 of 2)']);
      expect(table?.score).toMatchObject({ truePositives: 1, falseNegatives: 1 });
    });

    it('resolves a name declared in two files to the one in the expected file', () => {
      const result = evaluate(
        {
          nodes: [
            { ...node('x1', 'function', 'helper'), filePath: 'src/a.ts' },
            { ...node('x2', 'function', 'helper'), filePath: 'src/b.ts' },
          ],
          edges: [],
        },
        {
          ...truth,
          closedNodeTypes: [] as never,
          nodes: [{ type: 'function', name: 'helper', file: 'src/b.ts' }] as never,
          edges: [] as never,
        },
      );

      expect(result.nodeCategories.find((entry) => entry.category === 'function')?.mismatches).toEqual([]);
    });
  });

  describe('known gaps are scored, and a fixed gap fails the run', () => {
    const scip = { source: 'scip', confidence: 'high', method: 'scip' };
    const graph: CodeGraph = {
      nodes: [node('a', 'function', 'a'), node('b', 'function', 'b'), node('c', 'function', 'c')],
      edges: [edge('1', 'a', 'CALLS', 'b', scip), edge('2', 'a', 'CALLS', 'c', scip)],
    };
    const base = {
      fixture: 'synthetic',
      closedNodeTypes: [] as never,
      nodes: [] as never,
      closedRelationships: ['CALLS'] as never,
      paths: [] as never,
    };
    const ab = { from: { type: 'function', name: 'a' }, relationship: 'CALLS', to: { type: 'function', name: 'b' } };
    const ac = { from: { type: 'function', name: 'a' }, relationship: 'CALLS', to: { type: 'function', name: 'c' } };
    const bc = { from: { type: 'function', name: 'b' }, relationship: 'CALLS', to: { type: 'function', name: 'c' } };

    it('a known false positive lowers precision without failing the run', () => {
      const result = evaluate(graph, {
        ...base,
        edges: [ab] as never,
        knownFalsePositiveEdges: [{ ...ac, reason: 'known' }] as never,
      });
      const calls = result.edgeCategories.find((entry) => entry.category === 'CALLS');

      expect(calls?.score.precision).toBeCloseTo(0.5);
      expect(calls?.unexpected).toEqual([]);
      expect(calls?.knownUnexpected).toEqual(['function|a -CALLS-> function|c']);
      expect(result.passed).toBe(true);
    });

    it('a known gap lowers recall without failing the run', () => {
      const result = evaluate(graph, {
        ...base,
        edges: [ab, ac, { ...bc, knownGap: 'known' }] as never,
      });
      const calls = result.edgeCategories.find((entry) => entry.category === 'CALLS');

      expect(calls?.score.recall).toBeCloseTo(2 / 3);
      expect(calls?.missing).toEqual([]);
      expect(calls?.knownMissing).toEqual(['function|b -CALLS-> function|c']);
      expect(result.passed).toBe(true);
    });

    it('fails once a known gap is met, so the fix is noticed', () => {
      const result = evaluate(graph, { ...base, edges: [ab, { ...ac, knownGap: 'known' }] as never });

      expect(result.edgeCategories.find((entry) => entry.category === 'CALLS')?.staleKnownGaps[0]).toContain(
        'remove its knownGap',
      );
      expect(result.passed).toBe(false);
    });

    it('fails once a known false positive is no longer produced', () => {
      const result = evaluate(graph, {
        ...base,
        edges: [ab, ac] as never,
        knownFalsePositiveEdges: [{ ...bc, reason: 'known' }] as never,
      });

      expect(result.edgeCategories.find((entry) => entry.category === 'CALLS')?.staleKnownGaps[0]).toContain(
        'no longer produced',
      );
      expect(result.passed).toBe(false);
    });
  });

  describe('build diagnostics', () => {
    const clean = { unresolvedReferences: 3, droppedEdges: 0, failedAnalyzers: 0, readErrors: 0, truncated: false };

    it('reports what the build lost and passes when it matches the assertion', () => {
      const result = evaluate(complete, { ...truth, diagnostics: { droppedEdges: 0, truncated: false } }, { diagnostics: clean });

      expect(result.diagnostics.observed).toEqual(clean);
      expect(result.passed).toBe(true);
    });

    it('fails on a dropped edge or a truncated read the ground truth does not allow', () => {
      const result = evaluate(
        complete,
        { ...truth, diagnostics: { droppedEdges: 0, truncated: false } },
        { diagnostics: { ...clean, droppedEdges: 2, truncated: true } },
      );

      expect(result.diagnostics.problems).toEqual([
        'expected droppedEdges 0, found 2',
        'expected truncated false, found true',
      ]);
      expect(result.passed).toBe(false);
    });

    it('fails when diagnostics are asserted but were never supplied', () => {
      const result = evaluate(complete, { ...truth, diagnostics: { droppedEdges: 0 } });
      expect(result.passed).toBe(false);
    });
  });
});

describe('the bundled fixtures', () => {
  let run: BenchmarkRun;

  beforeAll(async () => {
    run = await runBenchmark();
  }, 60_000);

  const resultFor = (fixture: string): EvaluationResult => {
    const found = run.results.find((result) => result.fixture === fixture);
    if (!found) throw new Error(`no result for ${fixture}`);
    return found;
  };

  it('meets every expectation in every ground truth', () => {
    // Printed on failure so the reason is in the test output rather than
    // behind a separate command.
    if (!run.passed) process.stderr.write(formatReport(run.results, run.baselines));

    expect(run.results.map((result) => result.fixture)).toEqual(
      BENCHMARK_FIXTURES.map((fixture) => fixture.name),
    );
    expect(run.passed).toBe(true);
  });

  it('measures precision on the categories the dataset closes', () => {
    const result = resultFor('repository-knowledge-sample');

    expect(result.nodes.closed).toBe(true);
    expect(result.edges.closed).toBe(true);
    // Recall over every expectation, closed or not.
    expect(result.nodes.expected).toBeGreaterThan(50);
    expect(result.edges.expected).toBeGreaterThan(40);
  });

  it('closes all five code relationships on the golden fixture', () => {
    const result = resultFor('call-semantics-sample');

    for (const relationship of ['CALLS', 'REFERENCES', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']) {
      const category = result.edgeCategories.find((entry) => entry.category === relationship);
      expect(category?.score.closed, relationship).toBe(true);
      expect(category?.score.precision, relationship).not.toBeNull();
    }
  });

  it('scores the known defects instead of hiding them', () => {
    const calls = resultFor('call-semantics-sample').edgeCategories.find((entry) => entry.category === 'CALLS');

    // A function passed as a value is recorded as a call: precision says so.
    expect(calls?.knownUnexpected.length).toBeGreaterThan(0);
    expect(calls?.score.precision).toBeLessThan(1);
  });

  it('counts every produced item exactly once in a closed category', () => {
    for (const result of run.results) {
      for (const entry of [...result.nodeCategories, ...result.edgeCategories]) {
        if (!entry.score.closed) continue;
        expect(entry.score.truePositives + entry.score.falsePositives, `${result.fixture} ${entry.category}`).toBe(
          entry.score.produced,
        );
      }
    }
  });

  it('declines to measure precision where the dataset is a sample', () => {
    const open = resultFor('repository-knowledge-sample').nodeCategories.filter((entry) => !entry.score.closed);

    expect(open.length).toBeGreaterThan(0);
    for (const entry of open) expect(entry.score.precision).toBeNull();
  });

  it('attributes and locates every edge it should', () => {
    const evidence = resultFor('repository-knowledge-sample').evidence;

    expect(evidence.invalid).toBe(0);
    expect(evidence.located).toBe(evidence.locatable);
    expect(evidence.locatable).toBeGreaterThan(0);
  });

  it('builds the golden fixtures without losing anything', () => {
    for (const fixture of ['call-semantics-sample', 'typescript-sample']) {
      expect(resultFor(fixture).diagnostics).toMatchObject({
        observed: { droppedEdges: 0, failedAnalyzers: 0, readErrors: 0, truncated: false },
        problems: [],
      });
    }
  });

  it('agrees with the raw SCIP index on every fixture', () => {
    for (const baseline of run.baselines) expect(baseline.consistent).toBe(true);
  });

  it('produces a machine-readable report a CI job can diff', () => {
    const report = toMachineReport(run.results, '2026-01-01T00:00:00.000Z', run.baselines);

    expect(report).toMatchObject({
      schema: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      totals: { fixtures: BENCHMARK_FIXTURES.length, passed: BENCHMARK_FIXTURES.length },
    });

    const fixture = report.fixtures.find((entry) => entry.fixture === 'repository-knowledge-sample');
    expect(fixture?.paths.ratio).toBe(1);
    expect(fixture?.failures).toEqual({
      missingNodes: [],
      unexpectedNodes: [],
      missingEdges: [],
      unexpectedEdges: [],
      mismatches: [],
      staleKnownGaps: [],
      diagnostics: [],
    });
    expect(fixture?.scipBaseline?.consistent).toBe(true);

    const golden = report.fixtures.find((entry) => entry.fixture === 'call-semantics-sample');
    expect(golden?.knownGaps.unexpectedEdges.length).toBeGreaterThan(0);
    expect(golden?.diagnostics).toMatchObject({ droppedEdges: 0, truncated: false });

    // Serialisable: a report with a Map or an undefined in it is a report CI
    // cannot store.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('prints a report that names each failure rather than counting them', () => {
    const text = formatReport(run.results, run.baselines);

    expect(text).toContain('Repository Knowledge Graph Benchmark');
    expect(text).toContain('IMPLEMENTED_BY');
    expect(text).toContain('RESULT: pass');
    expect(text).toContain('[open]');
    expect(text).toContain('Known gaps');
    expect(text).toContain('Against the raw SCIP index');
  });
});
