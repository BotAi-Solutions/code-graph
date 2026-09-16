import type { CodeEdge, CodeGraph, CodeNode } from '../../types/index.js';

/**
 * Progressive exploration.
 *
 * The canvas never holds a repository. It holds one traversal — the base view —
 * plus whatever neighbourhoods the user has expanded, and this is where those
 * are put together. Merging is by node and edge id, which the server derives
 * from content, so the same node arriving from two fetches is one node and
 * expanding twice is idempotent.
 *
 * Keeping it a pure function is what makes "click to expand" testable without a
 * browser, and what keeps the canvas a view of data it is handed rather than a
 * cache with opinions.
 */
export function mergeGraphs(...graphs: ReadonlyArray<CodeGraph | null | undefined>): CodeGraph {
  const nodes = new Map<string, CodeNode>();
  const edges = new Map<string, CodeEdge>();

  for (const graph of graphs) {
    if (!graph) continue;
    for (const node of graph.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    for (const edge of graph.edges) if (!edges.has(edge.id)) edges.set(edge.id, edge);
  }

  // An edge whose endpoints are not both present would make Cytoscape throw.
  // It can happen legitimately: a neighbourhood fetch is capped, so its edges
  // may reach a node that was cut.
  const present = new Set(nodes.keys());

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter(
      (edge) => present.has(edge.sourceNodeId) && present.has(edge.targetNodeId),
    ),
  };
}

/** How many nodes an expansion would add that are not already displayed. */
export function newNodeCount(displayed: CodeGraph, addition: CodeGraph): number {
  const present = new Set(displayed.nodes.map((node) => node.id));
  return addition.nodes.filter((node) => !present.has(node.id)).length;
}
