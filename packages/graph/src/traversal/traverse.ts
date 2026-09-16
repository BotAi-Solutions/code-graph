import type { CodeEdge, CodeGraph, CodeNodeType, CodeRelationship } from '@ckg/shared';
import {
  GRAPH_DEFAULT_DEPTH,
  GRAPH_DEFAULT_NODE_LIMIT,
  GRAPH_DEFAULT_PATH_DEPTH,
  GRAPH_PATH_NODE_BUDGET,
} from '@ckg/shared';
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

// --- paths ------------------------------------------------------------------

/**
 * One edge crossed by a route, and which way it was crossed. Mirrors
 * `PathHop` in `@ckg/database` so the in-memory and SQL searches produce the
 * same answer for the same graph.
 */
export interface GraphPathHop {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationship: CodeRelationship;
  /** True when the route crossed this edge against its direction. */
  reversed: boolean;
}

export interface GraphPathOptions {
  maxDepth?: number;
  /** False walks edges both ways, which is the undirected fallback. */
  directed?: boolean;
  relationships?: readonly CodeRelationship[] | undefined;
  nodeTypes?: readonly CodeNodeType[] | undefined;
  /** Nodes the search may visit before giving up. */
  nodeBudget?: number;
}

export interface GraphPathResult {
  found: boolean;
  /** Node ids from `from` to `to` inclusive; empty when there is no route. */
  nodeIds: string[];
  hops: GraphPathHop[];
  truncated: boolean;
}

/**
 * The shortest route between two nodes of an in-memory graph.
 *
 * Breadth-first and level-by-level, exactly like the repository's SQL search,
 * down to the tie-break: within a level the predecessor of a node is the first
 * candidate under a total order over (node, direction, relationship, source,
 * target, edge). Two runs over the same graph therefore return the same route,
 * and so does the database given the same rows.
 */
export function findGraphPath(
  graph: CodeGraph,
  from: string,
  to: string,
  options: GraphPathOptions = {},
): GraphPathResult {
  const index = new CodeGraphIndex(graph);
  const maxDepth = options.maxDepth ?? GRAPH_DEFAULT_PATH_DEPTH;
  const directed = options.directed ?? true;
  const budget = options.nodeBudget ?? GRAPH_PATH_NODE_BUDGET;

  const allowedRelationships = options.relationships ? new Set(options.relationships) : null;
  const allowedTypes = options.nodeTypes ? new Set(options.nodeTypes) : null;

  if (!index.node(from) || !index.node(to)) {
    return { found: false, nodeIds: [], hops: [], truncated: false };
  }
  if (from === to) return { found: true, nodeIds: [from], hops: [], truncated: false };

  const cameFrom = new Map<string, GraphPathHop>();
  const seen = new Set<string>([from]);
  let frontier = [from];
  let truncated = false;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const candidates: GraphPathHop[] = [];

    for (const current of frontier) {
      for (const edge of index.edgesFrom(current)) {
        if (allowedRelationships && !allowedRelationships.has(edge.relationship)) continue;
        const target = index.node(edge.targetNodeId);
        if (!target || (allowedTypes && !allowedTypes.has(target.type))) continue;
        candidates.push(hopOf(edge, false));
      }

      if (directed) continue;

      for (const edge of index.edgesTo(current)) {
        if (allowedRelationships && !allowedRelationships.has(edge.relationship)) continue;
        const source = index.node(edge.sourceNodeId);
        if (!source || (allowedTypes && !allowedTypes.has(source.type))) continue;
        candidates.push(hopOf(edge, true));
      }
    }

    candidates.sort(comparePathHops);
    const next: string[] = [];

    for (const hop of candidates) {
      const other = hop.reversed ? hop.sourceNodeId : hop.targetNodeId;
      if (seen.has(other)) continue;

      if (seen.size >= budget) {
        truncated = true;
        break;
      }

      seen.add(other);
      cameFrom.set(other, hop);

      if (other === to) return { ...rebuild(cameFrom, from, to), truncated };
      next.push(other);
    }

    if (truncated) break;
    frontier = next;
  }

  return { found: false, nodeIds: [], hops: [], truncated };
}

function hopOf(edge: CodeEdge, reversed: boolean): GraphPathHop {
  return {
    edgeId: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    relationship: edge.relationship,
    reversed,
  };
}

/** The SQL's `ORDER BY other_id, reversed, relationship, source, target, edge`. */
function comparePathHops(a: GraphPathHop, b: GraphPathHop): number {
  const otherA = a.reversed ? a.sourceNodeId : a.targetNodeId;
  const otherB = b.reversed ? b.sourceNodeId : b.targetNodeId;

  return (
    otherA.localeCompare(otherB) ||
    Number(a.reversed) - Number(b.reversed) ||
    a.relationship.localeCompare(b.relationship) ||
    a.sourceNodeId.localeCompare(b.sourceNodeId) ||
    a.targetNodeId.localeCompare(b.targetNodeId) ||
    a.edgeId.localeCompare(b.edgeId)
  );
}

function rebuild(
  cameFrom: ReadonlyMap<string, GraphPathHop>,
  from: string,
  to: string,
): { found: boolean; nodeIds: string[]; hops: GraphPathHop[] } {
  const nodeIds = [to];
  const hops: GraphPathHop[] = [];

  let cursor = to;
  while (cursor !== from) {
    const hop = cameFrom.get(cursor);
    if (!hop) return { found: false, nodeIds: [], hops: [] };
    hops.push(hop);
    cursor = hop.reversed ? hop.targetNodeId : hop.sourceNodeId;
    nodeIds.push(cursor);
  }

  nodeIds.reverse();
  hops.reverse();
  return { found: true, nodeIds, hops };
}
