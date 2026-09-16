import forceAtlas2 from 'graphology-layout-forceatlas2';
import type Graph from 'graphology';
import type { CodeGraphModel } from '../model/graph-types.js';
import { GOLDEN_ANGLE, type ClusterLayout } from './cluster-engine.js';

/**
 * Positions.
 *
 * The layout runs in three movements, and each one exists because the movement
 * before it is not enough on its own:
 *
 * 1. **Seeding.** Every node is placed inside its cluster's disc on a
 *    golden-angle spiral, ordered by importance so hubs land near the centre
 *    and leaves near the rim. This is what replaces the random scatter a force
 *    layout normally starts from, and it is why the result is reproducible.
 * 2. **ForceAtlas2.** Left to itself the seeding is too regular to read as
 *    anything but a diagram of circles. FA2 in LinLog mode pulls genuinely
 *    related nodes together and lets unrelated ones drift, which is what makes
 *    the picture organic.
 * 3. **Cluster recall.** FA2 knows nothing about modules and will happily
 *    smear one across the view. A short pull back towards the cluster centroid
 *    between and after its passes keeps modules legible without flattening the
 *    structure FA2 just found.
 *
 * Everything here is synchronous and deterministic. At the slice sizes the API
 * returns it costs tens of milliseconds; the budget below scales the iteration
 * count down as the graph grows so a large repository degrades in layout
 * quality rather than in responsiveness.
 */

export interface LayoutOptions {
  /** Pulled from the graph mode; higher separates modules more firmly. */
  clusterSpread?: number;
  /** Cut the iteration budget, for an expansion rather than a fresh view. */
  quick?: boolean;
}

export interface Position {
  x: number;
  y: number;
}

/**
 * Iteration budget by graph size.
 *
 * FA2 is O(E) per iteration with Barnes-Hut, so the product is what matters.
 * A small graph can afford to be beautiful; a large one has to be quick, and
 * the seeding is already doing most of the structural work by then.
 */
function iterationsFor(order: number, quick: boolean): number {
  const full = order <= 200 ? 420 : order <= 800 ? 280 : order <= 2500 ? 140 : 70;
  return quick ? Math.round(full * 0.35) : full;
}

function settingsFor(order: number): Record<string, unknown> {
  return {
    // LinLog makes distance mean "how related", which is the reading we want:
    // clusters get tight, the space between them gets wide.
    linLogMode: true,
    outboundAttractionDistribution: true,
    // Hubs stop hogging the centre purely for being hubs, which matters on a
    // code graph where a file CONTAINS everything under it.
    adjustSizes: order <= 2000,
    edgeWeightInfluence: 0.6,
    scalingRatio: 12,
    strongGravityMode: false,
    gravity: 1.1,
    slowDown: 1 + Math.log1p(order) / 2,
    barnesHutOptimize: order > 800,
    barnesHutTheta: 0.6,
  };
}

/**
 * Where each node starts.
 *
 * Importance decides the radius: the most important node in a module sits at
 * its centre, so a hub is a hub before the force layout has run a single step,
 * and stays one after it. Exported separately from `applyLayout` because an
 * expansion seeds only its new nodes.
 */
export function seedPositions(
  model: CodeGraphModel,
  clusters: ClusterLayout,
): Map<string, Position> {
  const positions = new Map<string, Position>();

  for (const cluster of clusters.clusters) {
    const members = cluster.nodeIds
      .map((id) => model.nodesById.get(id))
      .filter((node): node is NonNullable<typeof node> => node !== undefined)
      .sort((a, b) => b.metrics.importance - a.metrics.importance);

    const count = members.length;

    members.forEach((node, index) => {
      if (count === 1) {
        positions.set(node.id, { x: cluster.x, y: cluster.y });
        return;
      }

      const angle = index * GOLDEN_ANGLE;
      // sqrt keeps the disc evenly covered; without it everything piles into
      // the middle and the rim is empty.
      const radius = cluster.radius * Math.sqrt((index + 0.4) / count);

      positions.set(node.id, {
        x: cluster.x + Math.cos(angle) * radius,
        y: cluster.y + Math.sin(angle) * radius,
      });
    });
  }

  // A node in no cluster should still be somewhere deliberate.
  let orphan = 0;
  for (const node of model.nodes) {
    if (positions.has(node.id)) continue;
    const angle = orphan * GOLDEN_ANGLE;
    const radius = 400 + orphan * 6;
    positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    orphan += 1;
  }

  return positions;
}

/**
 * Lays the graph out in place.
 *
 * The graph must already carry `x`, `y` and `size` on every node — FA2 reads
 * all three — which `graph-engine` guarantees by seeding before it calls here.
 */
export function applyLayout(
  graph: Graph,
  model: CodeGraphModel,
  clusters: ClusterLayout,
  options: LayoutOptions = {},
): void {
  const order = graph.order;
  if (order === 0) return;

  if (order <= 2) {
    // Two nodes have no layout; FA2 on them produces a division by zero's
    // worth of drift and nothing else.
    return;
  }

  const budget = iterationsFor(order, options.quick ?? false);
  const settings = settingsFor(order);

  // Two passes with a recall between them: the first finds structure, the
  // recall reminds it which module each node belongs to, the second lets it
  // settle around that.
  forceAtlas2.assign(graph, { iterations: Math.round(budget * 0.6), settings });
  recallToClusters(graph, model, clusters, 0.16);
  forceAtlas2.assign(graph, { iterations: Math.round(budget * 0.4), settings });
  recallToClusters(graph, model, clusters, 0.1);
  relaxOverlaps(graph, model);
}

/** A shorter run, for nodes that arrived after the first layout. */
export function refineLayout(
  graph: Graph,
  model: CodeGraphModel,
  clusters: ClusterLayout,
): void {
  if (graph.order <= 2) return;

  forceAtlas2.assign(graph, {
    iterations: iterationsFor(graph.order, true),
    settings: settingsFor(graph.order),
  });
  recallToClusters(graph, model, clusters, 0.12);
  relaxOverlaps(graph, model);
}

/**
 * The pass that makes the difference between a picture and a diagram: no node
 * drawn on top of another one.
 *
 * FA2 has a node-size term, but it measures size in *layout* units while the
 * renderer measures it in screen pixels, and the two are related by a scale
 * that only exists once the graph has been fitted to a viewport. So the
 * separation is derived here from the graph's own extent instead: a node
 * occupies roughly a fixed fraction of the view, whatever the coordinates
 * happen to be, which is exactly the invariant Sigma's auto-rescaling
 * guarantees.
 *
 * Bucketed into a uniform grid so it stays linear in the node count — a node
 * can only overlap something within one cell of it.
 */
function relaxOverlaps(graph: Graph, model: CodeGraphModel): void {
  const order = graph.order;
  if (order < 2) return;

  const nodes: Array<{ key: string; x: number; y: number; radius: number }> = [];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  graph.forEachNode((key, attributes) => {
    const x = attributes.x as number;
    const y = attributes.y as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    nodes.push({ key, x, y, radius: 0 });
  });

  if (nodes.length < 2 || !Number.isFinite(minX)) return;

  const extent = Math.max(maxX - minX, maxY - minY);
  if (extent <= 0) return;

  // A node is about 1.2% of the view across at rest, and an important one is
  // drawn larger, so it claims more room. Denser graphs get proportionally
  // less, or a thousand nodes could never be separated at all.
  const unit = (extent * 0.012) / Math.max(1, Math.log10(order) * 0.9);

  for (const node of nodes) {
    const importance = model.nodesById.get(node.key)?.metrics.importance ?? 0;
    node.radius = unit * (0.75 + importance * 1.1);
  }

  const cell = unit * 2.6;
  const buckets = new Map<string, number[]>();

  const keyOf = (x: number, y: number): string =>
    `${String(Math.floor(x / cell))}:${String(Math.floor(y / cell))}`;

  for (let pass = 0; pass < 14; pass += 1) {
    buckets.clear();

    nodes.forEach((node, index) => {
      const bucketKey = keyOf(node.x, node.y);
      const bucket = buckets.get(bucketKey);
      if (bucket) bucket.push(index);
      else buckets.set(bucketKey, [index]);
    });

    let moved = false;

    for (let index = 0; index < nodes.length; index += 1) {
      const a = nodes[index];
      if (!a) continue;

      const cellX = Math.floor(a.x / cell);
      const cellY = Math.floor(a.y / cell);

      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const bucket = buckets.get(`${String(cellX + dx)}:${String(cellY + dy)}`);
          if (!bucket) continue;

          for (const other of bucket) {
            if (other <= index) continue;
            const b = nodes[other];
            if (!b) continue;

            const ox = b.x - a.x;
            const oy = b.y - a.y;
            const distance = Math.hypot(ox, oy);
            const minimum = a.radius + b.radius;
            if (distance >= minimum) continue;

            // Coincident nodes have no direction to separate along; the index
            // difference supplies a stable one.
            const angle = distance > 1e-6 ? Math.atan2(oy, ox) : (index + other) * 2.399963;
            const push = (minimum - distance) / 2;
            const ux = distance > 1e-6 ? ox / distance : Math.cos(angle);
            const uy = distance > 1e-6 ? oy / distance : Math.sin(angle);

            a.x -= ux * push;
            a.y -= uy * push;
            b.x += ux * push;
            b.y += uy * push;
            moved = true;
          }
        }
      }
    }

    if (!moved) break;
  }

  const placed = new Map(nodes.map((node) => [node.key, node]));

  graph.updateEachNodeAttributes(
    (key, attributes) => {
      const node = placed.get(key);
      return node ? { ...attributes, x: node.x, y: node.y } : attributes;
    },
    { attributes: ['x', 'y'] },
  );
}

/**
 * Blends every node back towards its cluster centroid.
 *
 * `strength` is small on purpose. This is a nudge that keeps modules readable,
 * not a second layout: at 1 it would undo FA2 entirely and give back the tidy,
 * dead arrangement of step one.
 */
function recallToClusters(
  graph: Graph,
  model: CodeGraphModel,
  clusters: ClusterLayout,
  strength: number,
): void {
  const centroids = currentCentroids(graph, clusters);

  graph.updateEachNodeAttributes(
    (node, attributes) => {
      const clusterId = clusters.clusterOfNode.get(node);
      const centroid = clusterId ? centroids.get(clusterId) : undefined;
      if (!centroid) return attributes;

      const importance = model.nodesById.get(node)?.metrics.importance ?? 0;
      // An important node is pulled harder, which is what makes it the visual
      // anchor of its module rather than one dot among many.
      const pull = strength * (0.7 + importance * 0.6);

      return {
        ...attributes,
        x: (attributes.x as number) + (centroid.x - (attributes.x as number)) * pull,
        y: (attributes.y as number) + (centroid.y - (attributes.y as number)) * pull,
      };
    },
    { attributes: ['x', 'y'] },
  );
}

/**
 * Where each cluster actually ended up.
 *
 * Recalling to the *planned* centroid would drag the whole graph back to the
 * seeding and throw away what FA2 found. Recalling to where the members have
 * drifted to keeps the module together wherever it chose to go.
 */
function currentCentroids(graph: Graph, clusters: ClusterLayout): Map<string, Position> {
  const sums = new Map<string, { x: number; y: number; count: number }>();

  graph.forEachNode((node, attributes) => {
    const clusterId = clusters.clusterOfNode.get(node);
    if (!clusterId) return;

    const sum = sums.get(clusterId);
    if (sum) {
      sum.x += attributes.x as number;
      sum.y += attributes.y as number;
      sum.count += 1;
    } else {
      sums.set(clusterId, { x: attributes.x as number, y: attributes.y as number, count: 1 });
    }
  });

  const centroids = new Map<string, Position>();
  for (const [id, sum] of sums) {
    centroids.set(id, { x: sum.x / sum.count, y: sum.y / sum.count });
  }
  return centroids;
}
