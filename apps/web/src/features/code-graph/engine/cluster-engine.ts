import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { CodeGraphModel, GraphModule } from '../model/graph-types.js';

/**
 * Where the galaxy comes from.
 *
 * A force layout on its own produces a cloud: dense in the middle, uniform,
 * and impossible to read as a system. Clusters are what turn that into a
 * topology — related code near, unrelated code far — and they are computed from
 * the repository's own structure rather than from the picture.
 *
 * Three signals, in the order they are trusted:
 *
 * 1. **Module**, which is the source directory. It is what an engineer means
 *    when they say "the user module" and it is the only grouping the
 *    repository itself agrees with, so it wins wherever it exists.
 * 2. **Community detection**, used where the first signal degenerates. A
 *    repository that keeps everything in one directory has no module
 *    structure; Louvain finds the sub-structure that the topology implies and
 *    splits the blob into readable islands.
 * 3. **Inter-cluster dependency weight**, which does not group anything — it
 *    decides where the groups *go*, so two modules that talk constantly end up
 *    adjacent rather than on opposite sides of the view.
 */

export interface Cluster {
  id: string;
  label: string;
  kind: GraphModule['kind'];
  nodeIds: string[];
  /** Centroid, in layout space. */
  x: number;
  y: number;
  /** Radius the member nodes are seeded within. */
  radius: number;
}

export interface ClusterLayout {
  clusters: Cluster[];
  clusterOfNode: Map<string, string>;
  byId: Map<string, Cluster>;
}

export interface ClusterOptions {
  /**
   * How hard unrelated clusters are pushed apart. The mode sets it: an
   * unfiltered universe wants islands, a filtered architecture view wants one
   * readable region.
   */
  spread?: number;
}

/** A module holding more than this share of the graph is split further. */
const OVERSIZED_SHARE = 0.4;
/** ...but only when there is enough in it for the split to mean anything. */
const OVERSIZED_MINIMUM = 24;

/** Joins two cluster ids into one map key; cannot occur in an id. */
const PAIR_SEPARATOR = String.fromCharCode(1);

/** Golden angle: the standard way to spread points on a disc without clumps. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function detectClusters(
  model: CodeGraphModel,
  options: ClusterOptions = {},
): ClusterLayout {
  const spread = options.spread ?? 1;
  const groups = splitOversizedModules(model);

  const clusters: Cluster[] = groups.map((group) => ({
    ...group,
    x: 0,
    y: 0,
    // Area proportional to membership, so a cluster of forty is not forty times
    // wider than a cluster of one. The constant is generous on purpose: Sigma
    // rescales the whole graph to the viewport, so what reaches the screen is
    // the ratio between this and the distance between clusters, and a tight
    // ratio is what makes labels collide.
    radius: 34 + Math.sqrt(group.nodeIds.length) * 52,
  }));

  const clusterOfNode = new Map<string, string>();
  for (const cluster of clusters) {
    for (const nodeId of cluster.nodeIds) clusterOfNode.set(nodeId, cluster.id);
  }

  placeClusters(clusters, clusterWeights(model, clusterOfNode), spread);

  return { clusters, clusterOfNode, byId: new Map(clusters.map((c) => [c.id, c])) };
}

// --- grouping -------------------------------------------------------------

type ClusterGroup = Pick<Cluster, 'id' | 'label' | 'kind' | 'nodeIds'>;

function splitOversizedModules(model: CodeGraphModel): ClusterGroup[] {
  const total = model.nodes.length;
  const oversized = model.metadata.modules.filter(
    (module) =>
      module.kind === 'source' &&
      module.nodeIds.length >= OVERSIZED_MINIMUM &&
      module.nodeIds.length / Math.max(1, total) > OVERSIZED_SHARE,
  );

  if (oversized.length === 0) {
    return model.metadata.modules.map(toGroup);
  }

  const communities = detectCommunities(model);
  const groups: ClusterGroup[] = [];

  for (const module of model.metadata.modules) {
    if (!oversized.includes(module)) {
      groups.push(toGroup(module));
      continue;
    }

    const byCommunity = new Map<number, string[]>();
    for (const nodeId of module.nodeIds) {
      const community = communities.get(nodeId) ?? -1;
      const bucket = byCommunity.get(community);
      if (bucket) bucket.push(nodeId);
      else byCommunity.set(community, [nodeId]);
    }

    // A community of one or two is a stray, not an island: those stay with the
    // module so the split does not produce a halo of specks around it.
    const strays: string[] = [];
    const islands = [...byCommunity.entries()].sort((a, b) => b[1].length - a[1].length);
    let index = 0;

    for (const [, nodeIds] of islands) {
      if (nodeIds.length < 3) {
        strays.push(...nodeIds);
        continue;
      }
      index += 1;
      groups.push({
        id: `${module.id}#${String(index)}`,
        label: index === 1 ? module.label : `${module.label} · ${String(index)}`,
        kind: module.kind,
        nodeIds,
      });
    }

    if (strays.length > 0) {
      const first = groups.at(-1);
      if (first && first.id.startsWith(`${module.id}#`)) first.nodeIds.push(...strays);
      else groups.push({ id: module.id, label: module.label, kind: module.kind, nodeIds: strays });
    }
  }

  return groups;
}

function toGroup(module: GraphModule): ClusterGroup {
  return { id: module.id, label: module.label, kind: module.kind, nodeIds: [...module.nodeIds] };
}

/**
 * Louvain communities over the undirected graph.
 *
 * Seeded so the same graph always produces the same communities, and therefore
 * the same layout: a view that rearranges itself when you come back to it is a
 * view you cannot build a mental map of.
 */
function detectCommunities(model: CodeGraphModel): Map<string, number> {
  const graph = new Graph({ type: 'undirected', multi: false });

  for (const node of model.nodes) graph.addNode(node.id);
  for (const edge of model.edges) {
    if (edge.source === edge.target) continue;
    if (!graph.hasEdge(edge.source, edge.target)) graph.addEdge(edge.source, edge.target);
  }

  if (graph.size === 0) return new Map();

  const communities = louvain(graph, { rng: seededRandom(0x5eed), resolution: 1 });
  return new Map(Object.entries(communities));
}

// --- placement ------------------------------------------------------------

interface ClusterLink {
  a: number;
  b: number;
  weight: number;
}

function clusterWeights(
  model: CodeGraphModel,
  clusterOfNode: ReadonlyMap<string, string>,
): Map<string, number> {
  const weights = new Map<string, number>();

  for (const edge of model.edges) {
    const from = clusterOfNode.get(edge.source);
    const to = clusterOfNode.get(edge.target);
    if (!from || !to || from === to) continue;

    const key =
      from < to ? `${from}${PAIR_SEPARATOR}${to}` : `${to}${PAIR_SEPARATOR}${from}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }

  return weights;
}

/**
 * A force layout over the clusters themselves.
 *
 * Normally fifty or so bodies — the transform caps how many modules a view
 * distinguishes — so the O(n²) repulsion is free, and hand-rolling it avoids
 * both a dependency and the tuning fight that comes with running a general
 * layout on a graph this small. Deterministic from the first frame: the
 * starting positions are a golden-angle spiral, not random, so a graph laid out
 * twice looks the same twice.
 *
 * The iteration counts are derived from a fixed budget of pair comparisons
 * rather than fixed outright. A repository whose tree defeats the module cap
 * would otherwise pay quadratically for it — at nine thousand clusters that is
 * a minute of arithmetic — and the right failure there is a rougher
 * arrangement, not a frozen tab.
 */

/** Pair comparisons the force pass and the separation pass may each spend. */
const FORCE_BUDGET = 2_000_000;
const SEPARATION_BUDGET = 1_000_000;

function budgetedPasses(count: number, budget: number, min: number, max: number): number {
  const pairs = Math.max(1, (count * (count - 1)) / 2);
  return Math.max(min, Math.min(max, Math.round(budget / pairs)));
}
function placeClusters(
  clusters: Cluster[],
  weights: ReadonlyMap<string, number>,
  spread: number,
): void {
  const count = clusters.length;
  if (count === 0) return;

  if (count === 1) {
    const only = clusters[0];
    if (only) {
      only.x = 0;
      only.y = 0;
    }
    return;
  }

  const index = new Map(clusters.map((cluster, position) => [cluster.id, position]));
  const links: ClusterLink[] = [];

  for (const [key, weight] of weights) {
    const [fromId = '', toId = ''] = key.split(PAIR_SEPARATOR);
    const a = index.get(fromId);
    const b = index.get(toId);
    if (a === undefined || b === undefined) continue;
    links.push({ a, b, weight });
  }

  const scale = 160 * spread * Math.sqrt(count);
  for (let i = 0; i < count; i += 1) {
    const cluster = clusters[i];
    if (!cluster) continue;
    const angle = i * GOLDEN_ANGLE;
    const radius = scale * Math.sqrt((i + 0.5) / count);
    cluster.x = Math.cos(angle) * radius;
    cluster.y = Math.sin(angle) * radius;
  }

  // Velocity lives on a body rather than in a parallel array: there is one
  // body per cluster and at most a few dozen of them, so the clarity is worth
  // more than the packing.
  const bodies = clusters.map((cluster) => ({ cluster, vx: 0, vy: 0 }));

  const repulsion = 90000 * spread * spread;
  const iterations = budgetedPasses(count, FORCE_BUDGET, 12, 320);

  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;

    for (let i = 0; i < count; i += 1) {
      const first = bodies[i];
      if (!first) continue;

      for (let j = i + 1; j < count; j += 1) {
        const second = bodies[j];
        if (!second) continue;

        const a = first.cluster;
        const b = second.cluster;

        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distanceSquared = dx * dx + dy * dy;

        if (distanceSquared < 1) {
          // Two clusters exactly on top of each other have no direction to
          // separate along; the spiral index gives a stable one.
          dx = Math.cos(i * GOLDEN_ANGLE);
          dy = Math.sin(i * GOLDEN_ANGLE);
          distanceSquared = 1;
        }

        // Mass is membership: a big module should not be shoved aside by a
        // cluster of three.
        const mass = Math.sqrt((a.nodeIds.length + 1) * (b.nodeIds.length + 1));
        const force = (repulsion * mass) / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;

        first.vx += fx;
        first.vy += fy;
        second.vx -= fx;
        second.vy -= fy;
      }
    }

    for (const link of links) {
      const first = bodies[link.a];
      const second = bodies[link.b];
      if (!first || !second) continue;

      const a = first.cluster;
      const b = second.cluster;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const rest = (a.radius + b.radius) * 1.15;
      const pull = Math.log1p(link.weight) * 6 * (distance - rest);

      const fx = (dx / distance) * pull;
      const fy = (dy / distance) * pull;

      first.vx += fx;
      first.vy += fy;
      second.vx -= fx;
      second.vy -= fy;
    }

    const damping = 0.0016 * cooling;

    for (const body of bodies) {
      // Gravity keeps the whole thing from drifting apart; without it the
      // repulsion has nothing to push against and the view never settles.
      body.vx -= body.cluster.x * 0.9;
      body.vy -= body.cluster.y * 0.9;

      body.cluster.x += body.vx * damping;
      body.cluster.y += body.vy * damping;
      body.vx *= 0.82;
      body.vy *= 0.82;
    }
  }

  separate(clusters);
}

/**
 * A final pass that pushes overlapping clusters apart.
 *
 * The force layout gets the arrangement right but tolerates overlap, and two
 * modules drawn on top of each other are two modules the reader cannot see.
 */
function separate(clusters: Cluster[]): void {
  const passes = budgetedPasses(clusters.length, SEPARATION_BUDGET, 2, 24);

  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;

    for (let i = 0; i < clusters.length; i += 1) {
      const a = clusters[i];
      if (!a) continue;

      for (let j = i + 1; j < clusters.length; j += 1) {
        const b = clusters[j];
        if (!b) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const minimum = (a.radius + b.radius) * 1.08;
        if (distance >= minimum) continue;

        const push = (minimum - distance) / 2;
        const ux = dx / distance;
        const uy = dy / distance;

        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    }

    if (!moved) break;
  }
}

/** Mulberry32: small, fast, and seeded, which is the only property that matters. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { GOLDEN_ANGLE };
