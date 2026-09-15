import type { CodeEdge, CodeGraph, CodeNode } from '@ckg/shared';

/**
 * Stable JSON serialisation.
 *
 * Keys are emitted in a fixed order and arrays are sorted by id, so two runs
 * over the same repository produce byte-identical output. That is what makes
 * "did this commit change the graph?" answerable with a checksum.
 */

function serializeNode(node: CodeNode): Record<string, unknown> {
  return {
    id: node.id,
    projectId: node.projectId,
    type: node.type,
    name: node.name,
    ...(node.filePath !== undefined ? { filePath: node.filePath } : {}),
    ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
    ...(node.endLine !== undefined ? { endLine: node.endLine } : {}),
    ...(node.metadata !== undefined ? { metadata: sortKeys(node.metadata) } : {}),
  };
}

function serializeEdge(edge: CodeEdge): Record<string, unknown> {
  return {
    id: edge.id,
    projectId: edge.projectId,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    relationship: edge.relationship,
    ...(edge.metadata !== undefined ? { metadata: sortKeys(edge.metadata) } : {}),
  };
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

export function serializeGraph(graph: CodeGraph, space?: number): string {
  return JSON.stringify(
    {
      nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(serializeNode),
      edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)).map(serializeEdge),
    },
    null,
    space,
  );
}

export function deserializeGraph(json: string): CodeGraph {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as CodeGraph).nodes) ||
    !Array.isArray((parsed as CodeGraph).edges)
  ) {
    throw new Error('not a serialised code graph: expected { nodes: [], edges: [] }');
  }
  return parsed as CodeGraph;
}
