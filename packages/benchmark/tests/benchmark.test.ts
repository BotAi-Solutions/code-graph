import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CodeGraph } from '@ckg/shared';
import { evaluate } from '../src/evaluate.js';
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
});

describe('the bundled fixture', () => {
  let run: BenchmarkRun;

  beforeAll(async () => {
    run = await runBenchmark();
  }, 60_000);

  it('meets every expectation in its ground truth', () => {
    const result = run.results[0];

    // Printed on failure so the reason is in the test output rather than
    // behind a separate command.
    if (!run.passed) process.stderr.write(formatReport(run.results));

    expect(result?.fixture).toBe('repository-knowledge-sample');
    expect(run.passed).toBe(true);
  });

  it('measures precision on the categories the dataset closes', () => {
    const result = run.results[0];

    expect(result?.nodes.closed).toBe(true);
    expect(result?.edges.closed).toBe(true);
    // Recall over every expectation, closed or not.
    expect(result?.nodes.expected).toBeGreaterThan(50);
    expect(result?.edges.expected).toBeGreaterThan(40);
  });

  it('declines to measure precision where the dataset is a sample', () => {
    const open = run.results[0]?.nodeCategories.filter((entry) => !entry.score.closed) ?? [];

    expect(open.length).toBeGreaterThan(0);
    for (const entry of open) expect(entry.score.precision).toBeNull();
  });

  it('attributes and locates every edge it should', () => {
    const evidence = run.results[0]?.evidence;

    expect(evidence?.invalid).toBe(0);
    expect(evidence?.located).toBe(evidence?.locatable);
    expect(evidence?.locatable).toBeGreaterThan(0);
  });

  it('produces a machine-readable report a CI job can diff', () => {
    const report = toMachineReport(run.results, '2026-01-01T00:00:00.000Z');

    expect(report).toMatchObject({
      schema: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      totals: { fixtures: 1, passed: 1 },
    });

    const fixture = report.fixtures[0];
    expect(fixture?.paths.ratio).toBe(1);
    expect(fixture?.failures).toEqual({
      missingNodes: [],
      unexpectedNodes: [],
      missingEdges: [],
      unexpectedEdges: [],
      mismatches: [],
    });
    // Serialisable: a report with a Map or an undefined in it is a report CI
    // cannot store.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('prints a report that names each failure rather than counting them', () => {
    const text = formatReport(run.results);

    expect(text).toContain('Repository Knowledge Graph Benchmark');
    expect(text).toContain('IMPLEMENTED_BY');
    expect(text).toContain('RESULT: pass');
    expect(text).toContain('[open]');
  });
});
