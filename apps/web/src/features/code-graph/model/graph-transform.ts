import type { CodeEdge, CodeGraph, CodeNode } from '../../../types/index.js';
import {
  degreeCounts,
  emptyDegree,
  importanceOf,
  normalisedDegree,
  pageRank,
} from '../utils/graph-metrics.js';
import { nodeStyle, nodeLabel, nodeFullName } from './node-types.js';
import type {
  CodeGraphModel,
  GraphEdge,
  GraphMetadata,
  GraphModule,
  GraphNode,
} from './graph-types.js';

/**
 * SCIP graph → CodeGraph → **normalizeGraph** → Graphology → Sigma.
 *
 * This is the seam. Above it the API's vocabulary; below it the renderer's.
 * Keeping the transform in one pure function means the visualisation can be
 * rebuilt, restyled or replaced without touching anything that knows what SCIP
 * is, and it means every derived quantity — module, importance, centrality,
 * entry-point status — has exactly one definition.
 *
 * It is pure and synchronous. For the slice sizes the API returns (capped at
 * 2,000 nodes) it costs a handful of linear passes, and it is memoised by the
 * hook that calls it, so filtering or selecting never re-runs it.
 */

/** Below this a directory is not its own cluster; it joins its parent. */
const MIN_MODULE_SIZE = 3;

/**
 * Most modules a view will distinguish.
 *
 * Not a performance number — a legibility one. Nobody reads two hundred
 * regions on a canvas or two hundred chips in a filter, so beyond this the
 * directory tree is rolled up a level and the grouping becomes coarser rather
 * than more numerous. (It happens to bound the cluster layout too, which is
 * quadratic in the cluster count.)
 */
const MAX_MODULES = 48;

/** Separator that cannot occur in a node id, for composite map keys. */
const KEY_SEPARATOR = String.fromCharCode(0);

/** Basenames that mean "this is where the process starts". */
const ENTRY_POINT_NAMES = new Set([
  'index',
  'main',
  'app',
  'server',
  'worker',
  'cli',
  'bin',
  'start',
]);

export interface NormalizeContext {
  repository?: string | null;
  branch?: string | null;
  commit?: string | null;
}

export function normalizeGraph(graph: CodeGraph, context: NormalizeContext = {}): CodeGraphModel {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  // An edge pointing outside the returned node set is legitimate — a capped
  // neighbourhood cuts nodes but not their edges — and drawing one would ask
  // the renderer to place a line at a coordinate that does not exist.
  const edges = graph.edges.filter(
    (edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId),
  );

  const ids = graph.nodes.map((node) => node.id);
  const degrees = degreeCounts(ids, edges);
  const ranks = pageRank(ids, edges);
  const toDegreeScore = normalisedDegree([...degrees.values()].map((counts) => counts.degree));

  const exported = exportedNodeIds(edges);
  const modules = assignModules(graph.nodes);

  const nodes: GraphNode[] = graph.nodes.map((node) => {
    const style = nodeStyle(node.type);
    const counts = degrees.get(node.id) ?? emptyDegree();
    const metadata = node.metadata ?? {};
    const external = metadata.external === true;
    const role = typeof metadata.role === 'string' ? metadata.role : null;
    const assignment = modules.byNode.get(node.id);
    const isExported = exported.has(node.id);
    const entryPoint = isEntryPoint(node);

    return {
      id: node.id,
      label: nodeLabel(node),
      fullLabel: nodeFullName(node),
      type: node.type,
      file: node.filePath ?? null,
      module: assignment?.id ?? 'unassigned',
      moduleLabel: assignment?.label ?? 'Unassigned',
      directory: node.filePath ? directoryOf(node.filePath) : null,
      external,
      entryPoint,
      exported: isExported,
      role,
      metadata,
      metrics: {
        ...counts,
        centrality: ranks.get(node.id) ?? 0,
        importance: importanceOf({
          degreeScore: toDegreeScore(counts.degree),
          centrality: ranks.get(node.id) ?? 0,
          typeWeight: style.weight,
          entryPoint,
          exported: isExported,
          external,
          hasRole: role !== null,
        }),
      },
      source: node,
    };
  });

  const reciprocal = reciprocalPairs(edges);

  const modelEdges: GraphEdge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    type: edge.relationship,
    direction: reciprocal.has(pairKey(edge.sourceNodeId, edge.targetNodeId))
      ? 'mutual'
      : 'directed',
    weight: occurrencesOf(edge),
    metadata: edge.metadata ?? {},
    sourceEdge: edge,
  }));

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edgesById = new Map(modelEdges.map((edge) => [edge.id, edge]));

  const adjacency = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of modelEdges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }

  const metadata: GraphMetadata = {
    repository: context.repository ?? null,
    branch: context.branch ?? null,
    commit: context.commit ?? null,
    nodeCount: nodes.length,
    edgeCount: modelEdges.length,
    modules: modules.list,
    languages: languagesIn(graph.nodes),
    entryPointCount: nodes.filter((node) => node.entryPoint).length,
    externalCount: nodes.filter((node) => node.external).length,
  };

  return { nodes, edges: modelEdges, metadata, nodesById, edgesById, adjacency };
}

// --- modules --------------------------------------------------------------

interface ModuleAssignment {
  id: string;
  label: string;
}

interface ModuleIndex {
  byNode: Map<string, ModuleAssignment>;
  list: GraphModule[];
}

/**
 * Which cluster each node belongs to.
 *
 * Source directory first, because that is what an engineer means by "module"
 * and it is the only grouping the repository itself agrees with. Packages from
 * outside the repository go to one belt so they sit together at the edge of the
 * view instead of being scattered through the code that imports them, and the
 * data stores a repository talks to go to another — neither of those lives in a
 * directory, and leaving them unclustered is what produces the random scatter
 * a galaxy layout is supposed to avoid.
 *
 * A directory with only a node or two is not a module, it is a file that
 * happens to sit somewhere; those roll up to their parent until the cluster is
 * big enough to read as one.
 */
function assignModules(nodes: readonly CodeNode[]): ModuleIndex {
  const directoryOfNode = new Map<string, string>();
  const fixed = new Map<string, ModuleAssignment>();

  for (const node of nodes) {
    if (node.type === 'repository') {
      fixed.set(node.id, { id: 'repository', label: node.name });
      continue;
    }
    if (node.metadata?.external === true) {
      fixed.set(node.id, { id: 'external', label: 'External packages' });
      continue;
    }
    if (node.filePath) {
      directoryOfNode.set(node.id, directoryOf(node.filePath));
      continue;
    }
    fixed.set(node.id, { id: 'infrastructure', label: 'Infrastructure' });
  }

  const counts = new Map<string, number>();
  for (const directory of directoryOfNode.values()) {
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }

  // Deepest first, so a rolled-up child's nodes are counted towards its parent
  // before the parent decides whether it is big enough to stand on its own.
  const rollUp = new Map<string, string>();
  const byDepth = [...counts.keys()].sort((a, b) => depthOf(b) - depthOf(a));

  for (const directory of byDepth) {
    const size = counts.get(directory) ?? 0;
    if (size >= MIN_MODULE_SIZE || directory === '') continue;

    const parent = parentOf(directory);
    if (parent === directory) continue;

    rollUp.set(directory, parent);
    counts.set(parent, (counts.get(parent) ?? 0) + size);
    counts.set(directory, 0);
  }

  const resolve = (directory: string): string => {
    let cursor = directory;
    // Each step strictly shortens the path, so this terminates; the bound is
    // there only so a future change cannot turn it into a hang.
    for (let guard = 0; guard < 64; guard += 1) {
      const next = rollUp.get(cursor);
      if (next === undefined || next === cursor) break;
      cursor = next;
    }
    return cursor;
  };

  const rolled = [...directoryOfNode.values()].map(resolve);
  const depth = readableDepth(rolled);

  const byNode = new Map<string, ModuleAssignment>(fixed);
  for (const [nodeId, directory] of directoryOfNode) {
    const resolved = truncate(resolve(directory), depth);
    byNode.set(nodeId, {
      id: `dir:${resolved}`,
      label: resolved === '' ? 'Repository root' : resolved,
    });
  }

  const grouped = new Map<string, GraphModule>();
  for (const node of nodes) {
    const assignment = byNode.get(node.id);
    if (!assignment) continue;

    const existing = grouped.get(assignment.id);
    if (existing) {
      existing.nodeIds.push(node.id);
      continue;
    }

    grouped.set(assignment.id, {
      id: assignment.id,
      label: assignment.label,
      nodeIds: [node.id],
      kind: moduleKind(assignment.id),
    });
  }

  const list = [...grouped.values()].sort(
    (a, b) => b.nodeIds.length - a.nodeIds.length || a.label.localeCompare(b.label),
  );

  return { byNode, list };
}

function moduleKind(id: string): GraphModule['kind'] {
  if (id === 'external') return 'external';
  if (id === 'infrastructure') return 'infrastructure';
  if (id === 'repository') return 'root';
  return 'source';
}

export function directoryOf(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '' : filePath.slice(0, index);
}

function parentOf(directory: string): string {
  const index = directory.lastIndexOf('/');
  return index === -1 ? '' : directory.slice(0, index);
}

function depthOf(directory: string): number {
  return directory === '' ? 0 : directory.split('/').length;
}

function truncate(directory: string, depth: number): string {
  if (directory === '') return '';
  return directory.split('/').slice(0, depth).join('/');
}

/**
 * How many path segments to group by.
 *
 * A repository with four hundred leaf directories does not have four hundred
 * modules; it has a handful of areas with a lot of folders in them. This picks
 * the deepest grouping a reader can actually hold — the most specific depth
 * that still yields at most `MAX_MODULES` groups — and falls back one level
 * deeper when the shallowest grouping would collapse the whole repository into
 * a single region, because one region is not a topology.
 */
function readableDepth(directories: readonly string[]): number {
  const deepest = directories.reduce((max, directory) => Math.max(max, depthOf(directory)), 0);
  if (deepest === 0) return 0;

  const countAt = (depth: number): number =>
    new Set(directories.map((directory) => truncate(directory, depth))).size;

  for (let depth = deepest; depth >= 1; depth -= 1) {
    if (countAt(depth) <= MAX_MODULES) {
      // One group is the same as no grouping at all; prefer the next level
      // down and let the layout's own budget absorb the extra groups.
      return countAt(depth) <= 2 && depth < deepest ? depth + 1 : depth;
    }
  }

  return Math.min(2, deepest);
}

// --- node facts -----------------------------------------------------------

/**
 * Where execution enters the system.
 *
 * An HTTP route is one by definition — the analyzer found a real handler
 * registration. A file is one when it is named like a process entry point,
 * which is a naming convention rather than a compiler fact, and is labelled as
 * such wherever the number is shown.
 */
function isEntryPoint(node: CodeNode): boolean {
  if (node.type === 'api') return true;
  if (node.type !== 'file' || !node.filePath) return false;

  const base = node.filePath.slice(node.filePath.lastIndexOf('/') + 1);
  const stem = base.includes('.') ? base.slice(0, base.indexOf('.')) : base;
  return ENTRY_POINT_NAMES.has(stem.toLowerCase());
}

function exportedNodeIds(edges: readonly CodeEdge[]): Set<string> {
  const exported = new Set<string>();
  for (const edge of edges) {
    if (edge.relationship === 'EXPORTS') exported.add(edge.targetNodeId);
  }
  return exported;
}

function occurrencesOf(edge: CodeEdge): number {
  const occurrences = edge.metadata?.occurrences;
  return typeof occurrences === 'number' && occurrences > 0 ? occurrences : 1;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}${KEY_SEPARATOR}${b}` : `${b}${KEY_SEPARATOR}${a}`;
}

/** Pairs related in both directions, which the renderer separates. */
function reciprocalPairs(edges: readonly CodeEdge[]): Set<string> {
  const seen = new Map<string, Set<string>>();
  const mutual = new Set<string>();

  for (const edge of edges) {
    const key = pairKey(edge.sourceNodeId, edge.targetNodeId);
    const directions = seen.get(key);
    if (!directions) {
      seen.set(key, new Set([edge.sourceNodeId]));
      continue;
    }
    if (!directions.has(edge.sourceNodeId)) mutual.add(key);
    directions.add(edge.sourceNodeId);
  }

  return mutual;
}

function languagesIn(nodes: readonly CodeNode[]): string[] {
  const languages = new Set<string>();
  for (const node of nodes) {
    const language = node.metadata?.language;
    if (typeof language === 'string' && language.length > 0) languages.add(language);
  }
  return [...languages].sort();
}
