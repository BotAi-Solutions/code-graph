import { BEHAVIOURAL_RELATIONSHIPS, DEPENDENCY_RELATIONSHIPS } from '@ckg/shared';
import type { CodeEdge, CodeRelationship } from '../../../types/index.js';

/**
 * Structural facts about the displayed graph.
 *
 * Every number here is computed from the slice on screen and nothing else, so
 * it describes *this view*: a node's centrality in an architecture projection
 * is not its centrality in the whole repository, and the UI says so where it
 * matters. Recomputing per view is also what makes importance respond to the
 * mode the user chose, which is the point — the busiest node in a call graph
 * is rarely the busiest node in a file tree.
 *
 * All of it is O(V + E) or a fixed number of passes over the edges, and it runs
 * once per graph, memoised by the transform.
 */

const DEPENDENCY_SET: ReadonlySet<CodeRelationship> = new Set(DEPENDENCY_RELATIONSHIPS);
const BEHAVIOURAL_SET: ReadonlySet<CodeRelationship> = new Set(BEHAVIOURAL_RELATIONSHIPS);

export interface DegreeCounts {
  degree: number;
  inDegree: number;
  outDegree: number;
  dependencies: number;
  dependents: number;
}

export function emptyDegree(): DegreeCounts {
  return { degree: 0, inDegree: 0, outDegree: 0, dependencies: 0, dependents: 0 };
}

export function degreeCounts(
  nodeIds: readonly string[],
  edges: readonly CodeEdge[],
): Map<string, DegreeCounts> {
  const counts = new Map<string, DegreeCounts>(nodeIds.map((id) => [id, emptyDegree()]));

  for (const edge of edges) {
    const from = counts.get(edge.sourceNodeId);
    const to = counts.get(edge.targetNodeId);
    if (!from || !to) continue;

    from.degree += 1;
    from.outDegree += 1;
    to.degree += 1;
    to.inDegree += 1;

    if (DEPENDENCY_SET.has(edge.relationship)) {
      from.dependencies += 1;
      to.dependents += 1;
    }
  }

  return counts;
}

/**
 * PageRank over the displayed slice, normalised so the most central node
 * scores 1.
 *
 * Degree alone answers "what is busiest", which on a code graph is whichever
 * file happens to contain the most symbols. PageRank answers the more useful
 * question — what is *reached* by things that are themselves reached — which is
 * how a repository accessed only through its service still ranks as a hub.
 *
 * Only behavioural relationships are followed, for the same reason the server's
 * overview ranks by them: containment always wins a degree contest while saying
 * nothing about what the code does.
 *
 * Deterministic: fixed iteration count, no randomness, so the same graph always
 * produces the same ranking and therefore the same layout.
 */
export function pageRank(
  nodeIds: readonly string[],
  edges: readonly CodeEdge[],
  options: { damping?: number; iterations?: number } = {},
): Map<string, number> {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 30;
  const count = nodeIds.length;
  const ranks = new Map<string, number>();

  if (count === 0) return ranks;

  const index = new Map<string, number>(nodeIds.map((id, position) => [id, position]));
  const outgoing: number[][] = Array.from({ length: count }, () => []);
  const outDegree = new Float64Array(count);

  for (const edge of edges) {
    if (!BEHAVIOURAL_SET.has(edge.relationship)) continue;
    const from = index.get(edge.sourceNodeId);
    const to = index.get(edge.targetNodeId);
    if (from === undefined || to === undefined || from === to) continue;

    outgoing[from]?.push(to);
    outDegree[from] = (outDegree[from] ?? 0) + 1;
  }

  let current = new Float64Array(count).fill(1 / count);
  let next = new Float64Array(count);

  for (let round = 0; round < iterations; round += 1) {
    next.fill((1 - damping) / count);

    // A node with no outgoing behavioural edge would otherwise leak its rank
    // out of the system; spreading it evenly is the standard correction.
    let dangling = 0;
    for (let node = 0; node < count; node += 1) {
      if (outDegree[node] === 0) dangling += current[node] ?? 0;
    }
    const spill = (damping * dangling) / count;

    for (let node = 0; node < count; node += 1) {
      const targets = outgoing[node];
      if (targets && targets.length > 0) {
        const share = (damping * (current[node] ?? 0)) / targets.length;
        for (const target of targets) next[target] = (next[target] ?? 0) + share;
      }
      next[node] = (next[node] ?? 0) + spill;
    }

    const swap = current;
    current = next;
    next = swap;
  }

  let max = 0;
  for (let node = 0; node < count; node += 1) max = Math.max(max, current[node] ?? 0);
  const scale = max > 0 ? 1 / max : 0;

  for (let node = 0; node < count; node += 1) {
    ranks.set(nodeIds[node] as string, (current[node] ?? 0) * scale);
  }

  return ranks;
}

/**
 * Degree on a log scale, normalised to the busiest node.
 *
 * Linear degree is useless here: one repository node with 400 containment edges
 * would flatten every other node to zero. Log compresses the tail so the
 * difference between 2 and 8 neighbours still reads.
 */
export function normalisedDegree(degrees: readonly number[]): (degree: number) => number {
  const max = degrees.reduce((highest, value) => Math.max(highest, value), 0);
  if (max <= 0) return () => 0;

  const scale = 1 / Math.log1p(max);
  return (degree: number) => Math.log1p(Math.max(0, degree)) * scale;
}

export interface ImportanceInput {
  /** 0–1, from `normalisedDegree`. */
  degreeScore: number;
  /** 0–1, from `pageRank`. */
  centrality: number;
  /** 0–1, the node type's own weight. */
  typeWeight: number;
  entryPoint: boolean;
  exported: boolean;
  external: boolean;
  /** An analyzer classified it as a controller, service, repository or entity. */
  hasRole: boolean;
}

/**
 * How much of the canvas a node is entitled to.
 *
 * The four terms answer four different questions and none of them alone is
 * enough: degree finds hubs, centrality finds the things hubs depend on, type
 * weight keeps a lone database from disappearing among two hundred methods, and
 * the flags carry what the analyzers knew that the topology cannot show.
 *
 * External packages are pushed down deliberately. `express` is imported by
 * everything and is not what anyone is trying to understand; letting degree
 * make it the brightest object in the view would be actively misleading.
 */
export function importanceOf(input: ImportanceInput): number {
  const flags =
    (input.entryPoint ? 0.45 : 0) + (input.hasRole ? 0.35 : 0) + (input.exported ? 0.2 : 0);

  const score =
    0.3 * input.degreeScore +
    0.28 * input.centrality +
    0.26 * input.typeWeight +
    0.16 * Math.min(1, flags);

  return Math.max(0, Math.min(1, input.external ? score * 0.55 : score));
}
