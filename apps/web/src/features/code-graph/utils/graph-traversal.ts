import type { CodeGraphModel, ViewPath } from '../model/graph-types.js';

/**
 * Walks over the displayed graph.
 *
 * Everything here operates on what is on screen, which is a deliberate limit,
 * not an oversight: the server owns traversal of the *repository* graph and
 * will happily walk five hops from any node. These functions answer the
 * questions that only make sense about the current view — what would dim if I
 * hovered this, what is within two hops of my selection, is there a route
 * between these two things I can already see.
 */

export interface Neighbourhood {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  /** Nodes this one points at. */
  outgoing: Set<string>;
  /** Nodes that point at this one. */
  incoming: Set<string>;
}

export function neighbourhood(model: CodeGraphModel, nodeId: string): Neighbourhood {
  const result: Neighbourhood = {
    nodeIds: new Set([nodeId]),
    edgeIds: new Set(),
    outgoing: new Set(),
    incoming: new Set(),
  };

  for (const edge of model.edges) {
    if (edge.source === nodeId) {
      result.nodeIds.add(edge.target);
      result.outgoing.add(edge.target);
      result.edgeIds.add(edge.id);
    } else if (edge.target === nodeId) {
      result.nodeIds.add(edge.source);
      result.incoming.add(edge.source);
      result.edgeIds.add(edge.id);
    }
  }

  return result;
}

/**
 * Every node within `depth` undirected hops, including the root.
 *
 * Undirected because "show me what surrounds this" means both what it uses and
 * what uses it; a caller wanting one side asks the server with a direction.
 */
export function withinHops(
  model: CodeGraphModel,
  rootId: string,
  depth: number,
): Set<string> {
  const seen = new Set<string>([rootId]);
  if (depth <= 0 || !model.nodesById.has(rootId)) return seen;

  let frontier = [rootId];

  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];

    for (const id of frontier) {
      for (const neighbour of model.adjacency.get(id) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        next.push(neighbour);
      }
    }

    if (next.length === 0) break;
    frontier = next;
  }

  return seen;
}

/** Edges whose endpoints are both inside the set. */
export function inducedEdges(model: CodeGraphModel, nodeIds: ReadonlySet<string>): Set<string> {
  const edgeIds = new Set<string>();
  for (const edge of model.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) edgeIds.add(edge.id);
  }
  return edgeIds;
}

interface Arc {
  to: string;
  edgeId: string;
}

function adjacencyList(model: CodeGraphModel, directed: boolean): Map<string, Arc[]> {
  const arcs = new Map<string, Arc[]>();

  const push = (from: string, to: string, edgeId: string): void => {
    const existing = arcs.get(from);
    if (existing) existing.push({ to, edgeId });
    else arcs.set(from, [{ to, edgeId }]);
  };

  for (const edge of model.edges) {
    push(edge.source, edge.target, edge.id);
    if (!directed) push(edge.target, edge.source, edge.id);
  }

  return arcs;
}

export interface PathResult extends ViewPath {
  /** True when no directed route existed and the search ignored direction. */
  undirected: boolean;
}

/**
 * The shortest route between two displayed nodes.
 *
 * Direction is tried first, because "what is the path from the controller to
 * the repository" is a question about how a request actually flows. When no
 * directed route exists the search is repeated ignoring direction and the
 * result says so, which is more useful than "no path" — two components can be
 * genuinely related without one reaching the other.
 *
 * Breadth-first, so the route returned is the one with the fewest hops.
 */
export function findPath(model: CodeGraphModel, from: string, to: string): PathResult | null {
  if (!model.nodesById.has(from) || !model.nodesById.has(to)) return null;

  if (from === to) {
    return { from, to, nodeIds: [from], edgeIds: [], undirected: false };
  }

  const directed = search(model, from, to, true);
  if (directed) return { ...directed, from, to, undirected: false };

  const loose = search(model, from, to, false);
  if (loose) return { ...loose, from, to, undirected: true };

  return { from, to, nodeIds: [], edgeIds: [], undirected: false };
}

function search(
  model: CodeGraphModel,
  from: string,
  to: string,
  directed: boolean,
): { nodeIds: string[]; edgeIds: string[] } | null {
  const arcs = adjacencyList(model, directed);
  const cameFrom = new Map<string, { node: string; edgeId: string }>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head] as string;
    if (current === to) return rebuild(cameFrom, from, to);

    for (const arc of arcs.get(current) ?? []) {
      if (seen.has(arc.to)) continue;
      seen.add(arc.to);
      cameFrom.set(arc.to, { node: current, edgeId: arc.edgeId });
      queue.push(arc.to);
    }
  }

  return null;
}

function rebuild(
  cameFrom: ReadonlyMap<string, { node: string; edgeId: string }>,
  from: string,
  to: string,
): { nodeIds: string[]; edgeIds: string[] } {
  const nodeIds: string[] = [to];
  const edgeIds: string[] = [];

  let cursor = to;
  while (cursor !== from) {
    const step = cameFrom.get(cursor);
    if (!step) break;
    edgeIds.push(step.edgeId);
    nodeIds.push(step.node);
    cursor = step.node;
  }

  nodeIds.reverse();
  edgeIds.reverse();
  return { nodeIds, edgeIds };
}
