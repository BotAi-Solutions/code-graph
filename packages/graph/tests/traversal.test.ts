import { describe, expect, it } from 'vitest';
import { neighbours, serializeGraph, deserializeGraph, traverseGraph } from '@ckg/graph';
import type { CodeEdge, CodeGraph, CodeNode, CodeRelationship } from '@ckg/graph';

/**
 * A hand-built graph shaped like the sample application, so expected subgraphs
 * can be written out by hand:
 *
 *   file --CONTAINS--> Controller --CALLS--> Service --CALLS--> Repository
 *                                                         \--REFERENCES--> Model
 *   Controller --EXTENDS--> BaseController
 */
const PROJECT_ID = 'project-1';

function node(id: string, type: CodeNode['type'], name = id): CodeNode {
  return { id, projectId: PROJECT_ID, type, name };
}

function edge(source: string, relationship: CodeRelationship, target: string): CodeEdge {
  return {
    id: `${source}-${relationship}-${target}`,
    projectId: PROJECT_ID,
    sourceNodeId: source,
    targetNodeId: target,
    relationship,
  };
}

const GRAPH: CodeGraph = {
  nodes: [
    node('file', 'file', 'app.ts'),
    node('Controller', 'class'),
    node('BaseController', 'class'),
    node('Service', 'class'),
    node('Repository', 'class'),
    node('Model', 'interface'),
    node('orphan', 'variable'),
  ],
  edges: [
    edge('file', 'CONTAINS', 'Controller'),
    edge('Controller', 'EXTENDS', 'BaseController'),
    edge('Controller', 'CALLS', 'Service'),
    edge('Service', 'CALLS', 'Repository'),
    edge('Repository', 'REFERENCES', 'Model'),
  ],
};

const idsOf = (graph: CodeGraph): string[] => graph.nodes.map((item) => item.id).sort();

describe('traverseGraph', () => {
  it('returns only the root at depth 0', () => {
    const result = traverseGraph(GRAPH, { rootNodeId: 'Controller', depth: 0 });

    expect(idsOf(result)).toEqual(['Controller']);
    expect(result.edges).toEqual([]);
  });

  it('walks one hop in both directions at depth 1', () => {
    const result = traverseGraph(GRAPH, { rootNodeId: 'Service', depth: 1 });

    expect(idsOf(result)).toEqual(['Controller', 'Repository', 'Service']);
    expect(result.edges.map((item) => item.relationship).sort()).toEqual(['CALLS', 'CALLS']);
  });

  it('reaches the whole call chain at depth 3', () => {
    const result = traverseGraph(GRAPH, { rootNodeId: 'Controller', depth: 3 });

    expect(idsOf(result)).toEqual([
      'BaseController',
      'Controller',
      'Model',
      'Repository',
      'Service',
      'file',
    ]);
  });

  it('never reaches a disconnected node', () => {
    const result = traverseGraph(GRAPH, { rootNodeId: 'Controller', depth: 5 });

    expect(idsOf(result)).not.toContain('orphan');
  });

  it('records the distance of each node from the root', () => {
    const result = traverseGraph(GRAPH, { rootNodeId: 'Controller', depth: 3 });

    expect(result.depths.get('Controller')).toBe(0);
    expect(result.depths.get('Service')).toBe(1);
    expect(result.depths.get('Repository')).toBe(2);
    expect(result.depths.get('Model')).toBe(3);
  });

  it('restricts the walk to the requested relationships', () => {
    const result = traverseGraph(GRAPH, {
      rootNodeId: 'Controller',
      depth: 3,
      relationships: ['CALLS'],
    });

    // CONTAINS and EXTENDS are excluded, so `file` and `BaseController` are
    // unreachable and `Model` sits behind a REFERENCES edge.
    expect(idsOf(result)).toEqual(['Controller', 'Repository', 'Service']);
  });

  it('will not expand through an excluded node type', () => {
    const result = traverseGraph(GRAPH, {
      rootNodeId: 'file',
      depth: 3,
      nodeTypes: ['file', 'interface'],
    });

    // Reaching the interface would mean passing through class nodes.
    expect(idsOf(result)).toEqual(['file']);
  });

  it('stops at the node limit and says so', () => {
    const result = traverseGraph(GRAPH, { rootNodeId: 'Controller', depth: 5, limit: 3 });

    expect(result.nodes).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.nodes[0]?.id).toBe('Controller');
  });

  it('returns an empty graph for an unknown root', () => {
    const result = traverseGraph(GRAPH, { rootNodeId: 'missing', depth: 2 });

    expect(result).toMatchObject({ nodes: [], edges: [], truncated: false });
  });

  it('only includes edges whose endpoints are both in the result', () => {
    const result = traverseGraph(GRAPH, { rootNodeId: 'Service', depth: 1 });
    const ids = new Set(result.nodes.map((item) => item.id));

    for (const item of result.edges) {
      expect(ids.has(item.sourceNodeId)).toBe(true);
      expect(ids.has(item.targetNodeId)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const first = traverseGraph(GRAPH, { rootNodeId: 'Controller', depth: 3 });
    const second = traverseGraph(GRAPH, { rootNodeId: 'Controller', depth: 3 });

    expect(serializeGraph(first)).toBe(serializeGraph(second));
  });

  it('terminates on a cycle', () => {
    const cyclic: CodeGraph = {
      nodes: [node('a', 'class'), node('b', 'class'), node('c', 'class')],
      edges: [edge('a', 'CALLS', 'b'), edge('b', 'CALLS', 'c'), edge('c', 'CALLS', 'a')],
    };

    const result = traverseGraph(cyclic, { rootNodeId: 'a', depth: 10 });

    expect(idsOf(result)).toEqual(['a', 'b', 'c']);
  });
});

describe('neighbours', () => {
  it('follows outgoing edges for callees', () => {
    expect(neighbours(GRAPH, 'Service', 'outgoing', ['CALLS']).map((item) => item.id)).toEqual([
      'Repository',
    ]);
  });

  it('follows incoming edges for callers', () => {
    expect(neighbours(GRAPH, 'Service', 'incoming', ['CALLS']).map((item) => item.id)).toEqual([
      'Controller',
    ]);
  });

  it('returns nothing when no edge of that relationship exists', () => {
    expect(neighbours(GRAPH, 'Model', 'outgoing', ['CALLS'])).toEqual([]);
  });
});

describe('serializeGraph', () => {
  it('round-trips a graph', () => {
    const restored = deserializeGraph(serializeGraph(GRAPH));

    // Serialisation sorts by id — that is what makes the output comparable
    // across runs — so compare against the sorted originals.
    expect(restored.nodes).toEqual([...GRAPH.nodes].sort((a, b) => a.id.localeCompare(b.id)));
    expect(restored.edges).toEqual([...GRAPH.edges].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('is insensitive to input ordering, so it can be used as a checksum', () => {
    const shuffled: CodeGraph = {
      nodes: [...GRAPH.nodes].reverse(),
      edges: [...GRAPH.edges].reverse(),
    };

    expect(serializeGraph(shuffled)).toBe(serializeGraph(GRAPH));
  });

  it('rejects input that is not a graph', () => {
    expect(() => deserializeGraph('{"nodes":1}')).toThrow(/serialised code graph/);
  });
});
