import type { CodeEdge, CodeGraph, CodeNodeType, CodeRelationship } from '@ckg/shared';
import { GRAPH_DEFAULT_DEPTH, GRAPH_DEFAULT_NODE_LIMIT } from '@ckg/shared';
import { CodeGraphIndex } from '../model/types.js';

/**
 * Breadth-limited, undirected traversal over an in-memory graph.
 *
 * This mirrors the recursive CTE in `@ckg/database` exactly — same filter
 * semantics, same limit behaviour — so the two can be checked against each
 * other and so callers holding a graph in memory (tests, the dev script, a
 * future export) get identical results without a database.
 */

export interface TraversalOptions {
  rootNodeId: string;
  depth?: number;
  /** Node types the walk is allowed to expand into. The root is always kept. */
  nodeTypes?: readonly CodeNodeType[] | undefined;
  relationships?: readonly CodeRelationship[] | undefined;
  limit?: number;
}

export interface TraversalResult extends CodeGraph {
  /** Distance from the root for every returned node. */
  depths: Map<string, number>;
  truncated: boolean;
}

export function traverseGraph(graph: CodeGraph, options: TraversalOptions): TraversalResult {
  const index = new CodeGraphIndex(graph);
  const maxDepth = options.depth ?? GRAPH_DEFAULT_DEPTH;
  const limit = options.limit ?? GRAPH_DEFAULT_NODE_LIMIT;

  const allowedTypes = options.nodeTypes ? new Set(options.nodeTypes) : null;
  const allowedRelationships = options.relationships ? new Set(options.relationships) : null;

  const root = index.node(options.rootNodeId);
  if (!root) {
    return { nodes: [], edges: [], depths: new Map(), truncated: false };
  }

  const depths = new Map<string, number>([[root.id, 0]]);
  const queue: string[] = [root.id];
  let truncated = false;

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    const currentDepth = depths.get(currentId) as number;
    if (currentDepth >= maxDepth) continue;

    const touching = [...index.edgesFrom(currentId), ...index.edgesTo(currentId)];

    for (const edge of touching) {
      if (allowedRelationships && !allowedRelationships.has(edge.relationship)) continue;

      const neighbourId = edge.sourceNodeId === currentId ? edge.targetNodeId : edge.sourceNodeId;
      if (depths.has(neighbourId)) continue;

      const neighbour = index.node(neighbourId);
      if (!neighbour) continue;
      if (allowedTypes && !allowedTypes.has(neighbour.type)) continue;

      if (depths.size >= limit) {
        truncated = true;
        continue;
      }

      depths.set(neighbourId, currentDepth + 1);
      queue.push(neighbourId);
    }
  }

  // Deterministic ordering: by distance from the root, then by id.
  const nodes = [...depths.keys()]
    .map((id) => index.node(id))
    .filter((node): node is NonNullable<typeof node> => node !== undefined)
    .sort((a, b) => (depths.get(a.id) as number) - (depths.get(b.id) as number) || a.id.localeCompare(b.id));

  const edges: CodeEdge[] = graph.edges
    .filter(
      (edge) =>
        depths.has(edge.sourceNodeId) &&
        depths.has(edge.targetNodeId) &&
        (!allowedRelationships || allowedRelationships.has(edge.relationship)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  return { nodes, edges, depths, truncated };
}

/** Nodes reachable in one hop along `relationships`, in the given direction. */
export function neighbours(
  graph: CodeGraph,
  nodeId: string,
  direction: 'incoming' | 'outgoing',
  relationships: readonly CodeRelationship[],
): CodeGraph['nodes'] {
  const index = new CodeGraphIndex(graph);
  const allowed = new Set(relationships);

  const edges = direction === 'outgoing' ? index.edgesFrom(nodeId) : index.edgesTo(nodeId);

  return edges
    .filter((edge) => allowed.has(edge.relationship))
    .map((edge) => index.node(direction === 'outgoing' ? edge.targetNodeId : edge.sourceNodeId))
    .filter((node): node is NonNullable<typeof node> => node !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
