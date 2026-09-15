import { api, queryString } from './client.js';
import type {
  CodeGraph,
  CodeNode,
  GraphMeta,
  GraphSummary,
  GraphViewState,
  NodeDetail,
} from '../types/index.js';

export interface GraphResponse {
  graph: CodeGraph;
  meta: GraphMeta;
}

export async function fetchGraph(
  projectId: string,
  view: GraphViewState,
  signal?: AbortSignal,
): Promise<GraphResponse> {
  const query = queryString({
    ...(view.rootNodeId ? { rootNodeId: view.rootNodeId } : {}),
    depth: view.depth,
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

export async function searchNodes(
  projectId: string,
  term: string,
  signal?: AbortSignal,
): Promise<CodeNode[]> {
  const { data } = await api.get<CodeNode[]>(
    `/api/projects/${projectId}/graph/search${queryString({ q: term, limit: 15 })}`,
    signal,
  );
  return data;
}
