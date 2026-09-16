import { api, queryString } from './client.js';
import type {
  CodeGraph,
  CodeNodeType,
  GraphDirection,
  GraphMeta,
  GraphSearchPage,
  GraphSummary,
  GraphViewState,
  NodeDetail,
} from '../types/index.js';

export interface GraphResponse {
  graph: CodeGraph;
  meta: GraphMeta;
}

/** The base view: a traversal from a root, or the project overview. */
export async function fetchGraph(
  projectId: string,
  view: GraphViewState,
  signal?: AbortSignal,
): Promise<GraphResponse> {
  const query = queryString({
    ...(view.rootNodeId ? { rootNodeId: view.rootNodeId } : {}),
    ...(view.projection ? { projection: view.projection } : {}),
    depth: view.depth,
    direction: view.direction,
    nodeTypes: view.nodeTypes,
    relationships: view.relationships,
  });

  const { data, meta } = await api.get<CodeGraph>(
    `/api/projects/${projectId}/graph${query}`,
    signal,
  );

  return { graph: data, meta: meta as unknown as GraphMeta };
}

/**
 * One node's immediate neighbourhood, for expand-on-click.
 *
 * Same endpoint as the base view — expansion is a traversal with depth 1, not a
 * special case — which is why an expanded neighbourhood obeys the same filters
 * as everything else on the canvas.
 */
export async function fetchNeighbourhood(
  projectId: string,
  nodeId: string,
  view: Pick<GraphViewState, 'projection' | 'nodeTypes' | 'relationships'>,
  options: { depth?: number; direction?: GraphDirection; limit?: number } = {},
  signal?: AbortSignal,
): Promise<GraphResponse> {
  const query = queryString({
    rootNodeId: nodeId,
    depth: options.depth ?? 1,
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
    ...(view.projection ? { projection: view.projection } : {}),
    nodeTypes: view.nodeTypes,
    relationships: view.relationships,
  });

  const { data, meta } = await api.get<CodeGraph>(
    `/api/projects/${projectId}/graph${query}`,
    signal,
  );

  return { graph: data, meta: meta as unknown as GraphMeta };
}

export async function fetchGraphSummary(
  projectId: string,
  signal?: AbortSignal,
): Promise<GraphSummary> {
  const { data } = await api.get<GraphSummary>(
    `/api/projects/${projectId}/graph/summary`,
    signal,
  );
  return data;
}

export async function fetchNodeDetail(
  projectId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<NodeDetail> {
  const { data } = await api.get<NodeDetail>(
    `/api/projects/${projectId}/graph/nodes/${encodeURIComponent(nodeId)}`,
    signal,
  );
  return data;
}

/** Paged search over names, qualified names, paths, API routes and types. */
export async function searchNodes(
  projectId: string,
  term: string,
  options: { nodeTypes?: CodeNodeType[]; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<GraphSearchPage> {
  const limit = options.limit ?? 15;
  const offset = options.offset ?? 0;

  const { data, meta } = await api.get<GraphSearchPage['nodes']>(
    `/api/projects/${projectId}/graph/search${queryString({
      q: term,
      limit,
      offset,
      ...(options.nodeTypes?.length ? { nodeTypes: options.nodeTypes } : {}),
    })}`,
    signal,
  );

  return {
    nodes: data,
    total: typeof meta.total === 'number' ? meta.total : data.length,
    limit,
    offset,
  };
}
