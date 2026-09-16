import { describe, expect, it } from 'vitest';
import type { CodeEdge, CodeGraph, CodeNode, CodeRelationship } from '../src/types/index.js';
import { normalizeGraph } from '../src/features/code-graph/model/graph-transform.js';
import { degreeCounts, importanceOf, pageRank } from '../src/features/code-graph/utils/graph-metrics.js';
import {
  findPath,
  inducedEdges,
  neighbourhood,
  withinHops,
} from '../src/features/code-graph/utils/graph-traversal.js';
import { detectClusters } from '../src/features/code-graph/engine/cluster-engine.js';
import { seedPositions } from '../src/features/code-graph/engine/layout-engine.js';
import {
  NO_PRIORITY,
  detailLevelFor,
  inDetailScope,
  labelFor,
  labelScore,
} from '../src/features/code-graph/engine/label-engine.js';

/**
 * The normalisation layer and everything derived from it.
 *
 * This is where the visualisation stops speaking the API's vocabulary and
 * starts speaking its own, so it is where a mistake would be invisible: a
 * wrongly-clustered node still renders, a wrong importance still draws a
 * circle, and nobody would know. Hence the coverage.
 */

let counter = 0;

function node(
  type: CodeNode['type'],
  options: Partial<CodeNode> & { name?: string } = {},
): CodeNode {
  counter += 1;
  const id = options.id ?? `n${String(counter)}`;
  return {
    id,
    projectId: 'p1',
    type,
    name: options.name ?? id,
    ...options,
  };
}

function link(
  source: CodeNode,
  target: CodeNode,
  relationship: CodeRelationship = 'CALLS',
  metadata?: Record<string, unknown>,
): CodeEdge {
  counter += 1;
  return {
    id: `e${String(counter)}`,
    projectId: 'p1',
    sourceNodeId: source.id,
    targetNodeId: target.id,
    relationship,
    ...(metadata ? { metadata } : {}),
  };
}

describe('normalizeGraph', () => {
  it('drops edges whose endpoints are not both in the slice', () => {
    const a = node('class');
    const b = node('class');
    const graph: CodeGraph = {
      nodes: [a],
      edges: [link(a, b)],
    };

    expect(normalizeGraph(graph).edges).toHaveLength(0);
  });

  it('clusters nodes by the directory of their file', () => {
    const nodes = [
      node('class', { filePath: 'src/services/user.service.ts' }),
      node('method', { filePath: 'src/services/user.service.ts' }),
      node('class', { filePath: 'src/services/mail.service.ts' }),
      node('class', { filePath: 'src/controllers/user.controller.ts' }),
      node('class', { filePath: 'src/controllers/auth.controller.ts' }),
      node('class', { filePath: 'src/controllers/health.controller.ts' }),
    ];

    const model = normalizeGraph({ nodes, edges: [] });
    const modules = new Set(model.nodes.map((item) => item.module));

    expect(modules).toContain('dir:src/services');
    expect(modules).toContain('dir:src/controllers');
  });

  it('rolls a directory too small to be a module up into its parent', () => {
    const nodes = [
      node('class', { filePath: 'src/a/one.ts' }),
      node('class', { filePath: 'src/b/two.ts' }),
      node('class', { filePath: 'src/c/three.ts' }),
    ];

    const model = normalizeGraph({ nodes, edges: [] });

    // Three directories of one are three files that happen to sit somewhere,
    // not three modules.
    expect(new Set(model.nodes.map((item) => item.module))).toEqual(new Set(['dir:src']));
    expect(model.nodes.every((item) => item.directory?.startsWith('src/'))).toBe(true);
  });

  it('groups by a coarser directory depth rather than showing hundreds of modules', () => {
    // Four hundred leaf directories are not four hundred modules; they are a
    // handful of areas with a lot of folders in them. Nobody reads four
    // hundred regions on a canvas, and the cluster layout is quadratic in the
    // number of them.
    const nodes = Array.from({ length: 1200 }, (_, index) =>
      node('class', { filePath: `src/area${String(index % 6)}/leaf${String(index)}/file.ts` }),
    );

    const model = normalizeGraph({ nodes, edges: [] });

    expect(model.metadata.modules.length).toBeLessThanOrEqual(48);
    expect(model.metadata.modules.map((item) => item.id)).toContain('dir:src/area0');
  });

  it('puts external packages in their own belt and marks them', () => {
    const nodes = [
      node('module', { name: 'express', metadata: { external: true, declared: true } }),
      node('class', { filePath: 'src/app.ts' }),
    ];

    const model = normalizeGraph({ nodes, edges: [] });
    const external = model.nodes.find((item) => item.external);

    expect(external?.module).toBe('external');
    expect(model.metadata.externalCount).toBe(1);
  });

  it('puts data stores with no file in the infrastructure cluster', () => {
    const model = normalizeGraph({
      nodes: [node('database', { name: 'postgres' }), node('queue', { name: 'emails' })],
      edges: [],
    });

    expect(model.nodes.every((item) => item.module === 'infrastructure')).toBe(true);
  });

  it('counts HTTP routes and entry-point filenames as entry points', () => {
    const nodes = [
      node('api', { name: 'POST /users' }),
      node('file', { filePath: 'src/index.ts', name: 'index.ts' }),
      node('file', { filePath: 'src/user.service.ts', name: 'user.service.ts' }),
    ];

    const model = normalizeGraph({ nodes, edges: [] });

    expect(model.metadata.entryPointCount).toBe(2);
    expect(model.nodes.find((item) => item.file === 'src/user.service.ts')?.entryPoint).toBe(false);
  });

  it('marks a node exported when something exports it', () => {
    const file = node('file', { filePath: 'src/a.ts' });
    const symbol = node('class', { filePath: 'src/a.ts' });

    const model = normalizeGraph({
      nodes: [file, symbol],
      edges: [link(file, symbol, 'EXPORTS')],
    });

    expect(model.nodesById.get(symbol.id)?.exported).toBe(true);
    expect(model.nodesById.get(file.id)?.exported).toBe(false);
  });

  it('records an edge as mutual when the pair is related both ways', () => {
    const a = node('class');
    const b = node('class');

    const model = normalizeGraph({
      nodes: [a, b],
      edges: [link(a, b, 'CALLS'), link(b, a, 'REFERENCES')],
    });

    expect(model.edges.every((edge) => edge.direction === 'mutual')).toBe(true);
  });

  it('reads the observation count as edge weight, defaulting to one', () => {
    const a = node('class');
    const b = node('class');

    const model = normalizeGraph({
      nodes: [a, b],
      edges: [link(a, b, 'CALLS', { occurrences: 7 }), link(b, a, 'CALLS')],
    });

    expect(model.edges.map((edge) => edge.weight).sort()).toEqual([1, 7]);
  });

  it('builds undirected adjacency covering both ends of every edge', () => {
    const a = node('class');
    const b = node('class');

    const model = normalizeGraph({ nodes: [a, b], edges: [link(a, b)] });

    expect(model.adjacency.get(a.id)).toEqual([b.id]);
    expect(model.adjacency.get(b.id)).toEqual([a.id]);
  });

  it('gives a hub more importance than a leaf of the same type', () => {
    const hub = node('class', { filePath: 'src/core/hub.ts', name: 'Hub' });
    const leaves = Array.from({ length: 6 }, () =>
      node('class', { filePath: 'src/leaf/leaf.ts' }),
    );

    const model = normalizeGraph({
      nodes: [hub, ...leaves],
      edges: leaves.map((leaf) => link(leaf, hub)),
    });

    const hubImportance = model.nodesById.get(hub.id)?.metrics.importance ?? 0;
    const leafImportance = model.nodesById.get(leaves[0]?.id ?? '')?.metrics.importance ?? 0;

    expect(hubImportance).toBeGreaterThan(leafImportance);
  });
});

describe('metrics', () => {
  it('separates in-degree, out-degree and dependency direction', () => {
    const a = node('file');
    const b = node('file');
    const counts = degreeCounts([a.id, b.id], [link(a, b, 'IMPORTS')]);

    expect(counts.get(a.id)).toMatchObject({ outDegree: 1, inDegree: 0, dependencies: 1 });
    expect(counts.get(b.id)).toMatchObject({ outDegree: 0, inDegree: 1, dependents: 1 });
  });

  it('ranks the node everything points at highest, and is normalised to it', () => {
    const sink = node('class');
    const sources = Array.from({ length: 4 }, () => node('class'));
    const ids = [sink.id, ...sources.map((item) => item.id)];
    const ranks = pageRank(
      ids,
      sources.map((source) => link(source, sink)),
    );

    expect(ranks.get(sink.id)).toBe(1);
    for (const source of sources) {
      expect(ranks.get(source.id) ?? 1).toBeLessThan(1);
    }
  });

  it('is deterministic, so the same graph always lays out the same way', () => {
    const a = node('class');
    const b = node('class');
    const c = node('class');
    const ids = [a.id, b.id, c.id];
    const edges = [link(a, b), link(b, c), link(c, a)];

    expect(pageRank(ids, edges)).toEqual(pageRank(ids, edges));
  });

  it('follows only behavioural relationships, because containment says nothing', () => {
    const file = node('file');
    const symbol = node('class');
    const ranks = pageRank([file.id, symbol.id], [link(file, symbol, 'CONTAINS')]);

    // With no behavioural edge at all, rank is uniform — the containment edge
    // did not make the symbol a hub.
    expect(ranks.get(file.id)).toBe(ranks.get(symbol.id));
  });

  it('holds external packages back however connected they are', () => {
    const shared = {
      degreeScore: 1,
      centrality: 1,
      typeWeight: 0.6,
      entryPoint: false,
      exported: false,
      hasRole: false,
    };

    expect(importanceOf({ ...shared, external: true })).toBeLessThan(
      importanceOf({ ...shared, external: false }),
    );
  });

  it('keeps importance inside 0–1 at both extremes', () => {
    const maximal = importanceOf({
      degreeScore: 1,
      centrality: 1,
      typeWeight: 1,
      entryPoint: true,
      exported: true,
      external: false,
      hasRole: true,
    });
    const minimal = importanceOf({
      degreeScore: 0,
      centrality: 0,
      typeWeight: 0,
      entryPoint: false,
      exported: false,
      external: false,
      hasRole: false,
    });

    expect(maximal).toBeLessThanOrEqual(1);
    expect(minimal).toBeGreaterThanOrEqual(0);
    expect(maximal).toBeGreaterThan(minimal);
  });
});

describe('traversal', () => {
  const controller = node('class', { name: 'UserController' });
  const service = node('class', { name: 'UserService' });
  const repository = node('class', { name: 'UserRepository' });
  const stray = node('class', { name: 'Unrelated' });

  const model = normalizeGraph({
    nodes: [controller, service, repository, stray],
    edges: [link(controller, service), link(service, repository)],
  });

  it('reports a node’s immediate neighbourhood with direction', () => {
    const result = neighbourhood(model, service.id);

    expect(result.incoming).toEqual(new Set([controller.id]));
    expect(result.outgoing).toEqual(new Set([repository.id]));
    expect(result.edgeIds.size).toBe(2);
  });

  it('walks outward by hops, ignoring direction', () => {
    expect(withinHops(model, controller.id, 1)).toEqual(new Set([controller.id, service.id]));
    expect(withinHops(model, controller.id, 2)).toEqual(
      new Set([controller.id, service.id, repository.id]),
    );
    expect(withinHops(model, controller.id, 0)).toEqual(new Set([controller.id]));
  });

  it('finds the directed route and every step on it', () => {
    const path = findPath(model, controller.id, repository.id);

    expect(path?.undirected).toBe(false);
    expect(path?.nodeIds).toEqual([controller.id, service.id, repository.id]);
    expect(path?.edgeIds).toHaveLength(2);
  });

  it('falls back to an undirected route and says that it did', () => {
    const path = findPath(model, repository.id, controller.id);

    expect(path?.undirected).toBe(true);
    expect(path?.nodeIds).toEqual([repository.id, service.id, controller.id]);
  });

  it('returns an empty route rather than null when there is genuinely none', () => {
    const path = findPath(model, controller.id, stray.id);

    expect(path).not.toBeNull();
    expect(path?.nodeIds).toEqual([]);
  });

  it('returns null for a node that is not in the view', () => {
    expect(findPath(model, controller.id, 'missing')).toBeNull();
  });

  it('collects every edge between the nodes of a set', () => {
    const edges = inducedEdges(model, new Set([controller.id, service.id]));

    expect(edges.size).toBe(1);
  });
});

describe('clustering and seeding', () => {
  function sampleModel(): ReturnType<typeof normalizeGraph> {
    const services = Array.from({ length: 5 }, (_, index) =>
      node('class', { filePath: `src/services/s${String(index)}.ts` }),
    );
    const controllers = Array.from({ length: 4 }, (_, index) =>
      node('class', { filePath: `src/controllers/c${String(index)}.ts` }),
    );
    const database = node('database', { name: 'postgres' });

    return normalizeGraph({
      nodes: [...services, ...controllers, database],
      edges: [
        ...controllers.map((controller, index) => link(controller, services[index] ?? services[0]!)),
        ...services.map((service) => link(service, database, 'WRITES_TO')),
      ],
    });
  }

  it('assigns every node to exactly one cluster', () => {
    const model = sampleModel();
    const layout = detectClusters(model);

    expect(layout.clusterOfNode.size).toBe(model.nodes.length);
    for (const node of model.nodes) {
      expect(layout.byId.has(layout.clusterOfNode.get(node.id) ?? '')).toBe(true);
    }
  });

  it('separates clusters instead of drawing them on top of each other', () => {
    const layout = detectClusters(sampleModel());

    for (let i = 0; i < layout.clusters.length; i += 1) {
      for (let j = i + 1; j < layout.clusters.length; j += 1) {
        const a = layout.clusters[i]!;
        const b = layout.clusters[j]!;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);

        expect(distance).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic, so a view looks the same every time it is opened', () => {
    const model = sampleModel();
    const first = detectClusters(model).clusters.map((cluster) => [cluster.id, cluster.x, cluster.y]);
    const second = detectClusters(model).clusters.map((cluster) => [
      cluster.id,
      cluster.x,
      cluster.y,
    ]);

    expect(first).toEqual(second);
  });

  it('seeds every node at a finite position inside its cluster', () => {
    const model = sampleModel();
    const layout = detectClusters(model);
    const positions = seedPositions(model, layout);

    expect(positions.size).toBe(model.nodes.length);

    for (const node of model.nodes) {
      const position = positions.get(node.id)!;
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);

      const cluster = layout.byId.get(layout.clusterOfNode.get(node.id) ?? '')!;
      expect(Math.hypot(position.x - cluster.x, position.y - cluster.y)).toBeLessThanOrEqual(
        cluster.radius + 1e-6,
      );
    }
  });

  it('seeds the most important node of a cluster nearest its centre', () => {
    const model = sampleModel();
    const layout = detectClusters(model);
    const positions = seedPositions(model, layout);

    for (const cluster of layout.clusters) {
      if (cluster.nodeIds.length < 3) continue;

      const ranked = cluster.nodeIds
        .map((id) => model.nodesById.get(id)!)
        .sort((a, b) => b.metrics.importance - a.metrics.importance);

      const first = positions.get(ranked[0]!.id)!;
      const last = positions.get(ranked.at(-1)!.id)!;

      expect(Math.hypot(first.x - cluster.x, first.y - cluster.y)).toBeLessThan(
        Math.hypot(last.x - cluster.x, last.y - cluster.y),
      );
    }
  });
});

describe('semantic zoom', () => {
  const service = node('service', { name: 'UserService' });
  const parameter = node('parameter', { name: 'id', filePath: 'src/a.ts' });
  const model = normalizeGraph({ nodes: [service, parameter], edges: [] });
  const serviceNode = model.nodesById.get(service.id)!;
  const parameterNode = model.nodesById.get(parameter.id)!;

  it('reads the camera ratio backwards, because Sigma shrinks it as you zoom in', () => {
    expect(detailLevelFor(3)).toBe('overview');
    expect(detailLevelFor(0.8)).toBe('structure');
    expect(detailLevelFor(0.2)).toBe('detail');
  });

  it('keeps architecture in scope at every zoom and low-level symbols only up close', () => {
    expect(inDetailScope(serviceNode, 'overview')).toBe(true);
    expect(inDetailScope(parameterNode, 'overview')).toBe(false);
    expect(inDetailScope(parameterNode, 'detail')).toBe(true);
  });

  it('labels the architecture far out and leaves the rest until you zoom in', () => {
    expect(labelFor(serviceNode, { level: 'overview', density: 1, forced: false, priority: NO_PRIORITY }).label).toBe(
      serviceNode.label,
    );
    expect(labelFor(parameterNode, { level: 'overview', density: 1, forced: false, priority: NO_PRIORITY }).label).toBeNull();
    expect(labelFor(parameterNode, { level: 'detail', density: 1, forced: false, priority: NO_PRIORITY }).label).toBe(
      parameterNode.label,
    );
  });

  it('always labels what the user asked about, whatever the zoom', () => {
    const decision = labelFor(parameterNode, { level: 'overview', density: 1, forced: true, priority: NO_PRIORITY });

    expect(decision.label).toBe(parameterNode.label);
    expect(decision.alpha).toBe(1);
  });

  it('fades a label in rather than snapping it on', () => {
    const decision = labelFor(serviceNode, { level: 'overview', density: 1, forced: false, priority: NO_PRIORITY });

    expect(decision.alpha).toBeGreaterThan(0);
    expect(decision.alpha).toBeLessThanOrEqual(1);
  });

  it('scores a service above a parameter', () => {
    expect(labelScore(serviceNode)).toBeGreaterThan(labelScore(parameterNode));
  });

  it('keeps the mode’s own subject in scope and named at any zoom', () => {
    // A call graph that renders its methods as unlabelled specks has answered
    // a question nobody asked, so the projection's priority types override the
    // global type ranking.
    const priority = new Set<CodeNode['type']>(['parameter']);

    expect(inDetailScope(parameterNode, 'overview')).toBe(false);
    expect(inDetailScope(parameterNode, 'overview', priority)).toBe(true);

    expect(labelScore(parameterNode, priority)).toBeGreaterThan(labelScore(parameterNode));
  });

  it('gives a class an analyzer called a service the label weight of one', () => {
    const plain = node('class', { name: 'Thing', filePath: 'src/a.ts' });
    const classified = node('class', {
      name: 'UserService',
      filePath: 'src/a.ts',
      metadata: { role: 'service' },
    });
    const roles = normalizeGraph({ nodes: [plain, classified], edges: [] });

    expect(labelScore(roles.nodesById.get(classified.id)!)).toBeGreaterThan(
      labelScore(roles.nodesById.get(plain.id)!),
    );
  });
});
