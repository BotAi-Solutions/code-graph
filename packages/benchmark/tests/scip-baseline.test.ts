import { beforeAll, describe, expect, it } from 'vitest';
import type { CodeEdge } from '@ckg/shared';
import { buildFixtureGraph, type BuiltFixture } from '../src/graph-source.js';
import { compareWithScip } from '../src/scip-baseline.js';

/**
 * The graph against the raw SCIP index it was built from.
 *
 * Runs on every checked-in SCIP fixture, including the ones without a ground
 * truth, because it needs none: the index is the baseline. Then the comparison
 * itself is checked by breaking a graph in each way it is meant to notice.
 */

const ALL_SCIP_FIXTURES = [
  'typescript-sample',
  'express-postgres-sample',
  'repository-knowledge-sample',
  'kysely-sample',
  'function-values-sample',
  'call-semantics-sample',
];

describe('every SCIP fixture agrees with its index', () => {
  for (const name of ALL_SCIP_FIXTURES) {
    it(name, async () => {
      const built = await buildFixtureGraph({ name, title: name });
      const baseline = compareWithScip(built.index, built.graph, {
        reportedUnresolved: built.diagnostics.unresolvedReferences,
      });

      expect(baseline.definitions.unexplained).toEqual([]);
      expect(baseline.identity.symbolsWithSeveralNodes).toEqual([]);
      expect(baseline.locations.mismatches).toEqual([]);
      expect(baseline.uses.onlyScip).toEqual([]);
      expect(baseline.uses.onlyGraph).toEqual([]);
      expect(baseline.inheritance.onlyScip).toEqual([]);
      expect(baseline.inheritance.onlyGraph).toEqual([]);
      expect(baseline.references.unresolvedConsistent).toBe(true);
      expect(baseline.consistent).toBe(true);

      // The builder's own split of the same references agrees with the index:
      // what it calls unmodelled is defined there, and external plus unknown
      // is everything the index never defined.
      const split = built.graph.stats.unresolvedReferences;
      expect(split.unmodelled).toBe(baseline.references.toUnmodelledSymbols);
      expect(split.external + split.unknown).toBe(baseline.references.external);
      expect(split.external + split.unmodelled + split.unknown).toBe(
        built.graph.stats.unresolvedReferenceCount,
      );
    });
  }
});

describe('the comparison notices', () => {
  let built: BuiltFixture;

  beforeAll(async () => {
    built = await buildFixtureGraph({ name: 'call-semantics-sample', title: 'golden' });
  });

  const nodeId = (name: string): string => {
    const found = built.graph.nodes.find((node) => (node.qualifiedName ?? node.name) === name);
    if (!found) throw new Error(`no node ${name}`);
    return found.id;
  };

  const isUse = (edge: CodeEdge, from: string, to: string): boolean =>
    edge.sourceNodeId === nodeId(from) && edge.targetNodeId === nodeId(to);

  it('a use the graph lost', () => {
    const graph = {
      ...built.graph,
      edges: built.graph.edges.filter((edge) => !isUse(edge, 'invokes', 'format')),
    };
    const baseline = compareWithScip(built.index, graph);

    expect(baseline.uses.onlyScip).toEqual(['function|invokes -> function|format']);
    expect(baseline.consistent).toBe(false);
  });

  it('a use the index does not support', () => {
    const graph = {
      ...built.graph,
      edges: [
        ...built.graph.edges,
        {
          id: 'invented',
          projectId: 'p',
          sourceNodeId: nodeId('register'),
          targetNodeId: nodeId('format'),
          relationship: 'CALLS',
          metadata: { source: 'scip', confidence: 'high', method: 'scip' },
        } as CodeEdge,
      ],
    };
    const baseline = compareWithScip(built.index, graph);

    expect(baseline.uses.onlyGraph).toEqual(['function|register -> function|format']);
    expect(baseline.uses.precision).toBeLessThan(1);
  });

  it('an inheritance edge the graph lost', () => {
    const graph = {
      ...built.graph,
      edges: built.graph.edges.filter((edge) => !isUse(edge, 'Square', 'BaseShape') || edge.relationship !== 'EXTENDS'),
    };

    expect(compareWithScip(built.index, graph).inheritance.onlyScip).toEqual(['class|Square -> class|BaseShape']);
  });

  it('a node whose lines moved', () => {
    const graph = {
      ...built.graph,
      nodes: built.graph.nodes.map((node) =>
        (node.qualifiedName ?? node.name) === 'format' ? { ...node, startLine: (node.startLine ?? 0) + 1 } : node,
      ),
    };

    expect(compareWithScip(built.index, graph).locations.mismatches).toHaveLength(1);
  });

  it('a symbol that lost its node', () => {
    const graph = {
      ...built.graph,
      nodes: built.graph.nodes.filter((node) => (node.qualifiedName ?? node.name) !== 'format'),
    };

    expect(compareWithScip(built.index, graph).definitions.unexplained).toEqual([
      expect.stringContaining('`geometry.ts`/format().'),
    ]);
  });

  it('an unresolved count that does not add up', () => {
    const baseline = compareWithScip(built.index, built.graph, {
      reportedUnresolved: built.diagnostics.unresolvedReferences + 1,
    });

    expect(baseline.references.unresolvedConsistent).toBe(false);
    expect(baseline.consistent).toBe(false);
  });

  it('splits what the graph calls unresolved into external and unmodelled', () => {
    const { references } = compareWithScip(built.index, built.graph);

    // value.toFixed() is the one reference to something outside the repository;
    // the rest of the "unresolved" count is uses of in-repository parameters.
    expect(references.external).toBe(1);
    expect(references.toUnmodelledSymbols).toBeGreaterThan(0);
  });

  it('flags one symbol with two declarations: the static and the instance Square.area', () => {
    const { definitions } = compareWithScip(built.index, built.graph);

    expect(definitions.multiplyDefined).toEqual([expect.stringContaining('Square#area().')]);
  });
});
