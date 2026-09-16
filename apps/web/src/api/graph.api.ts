import { api, queryString } from './client.js';
import type {
  CodeGraph,
  CodeNode,
  CodeNodeType,
  Definition,
  GraphDirection,
  GraphMeta,
  GraphPath,
  GraphProjectionId,
  GraphSearchPage,
  GraphSummary,
  GraphViewState,
  NodeDetail,
  RelatedNode,
  SourceTree,
} from '../types/index.js';

export interface GraphResponse {
  graph: CodeGraph;
  meta: GraphMeta;
}

/**
 * The base view: a traversal from a root, or the project overview.
 *
 * `limit` is how many nodes the view is willing to draw. The server caps it at
 * `GRAPH_MAX_NODE_LIMIT` whatever is asked for; leaving it off takes the
 * server's default.
 */
export async function fetchGraph(
  projectId: string,
  view: GraphViewState,
  signal?: AbortSignal,
  limit?: number,
): Promise<GraphResponse> {
  const query = queryString({
    ...(view.rootNodeId ? { rootNodeId: view.rootNodeId } : {}),
    ...(view.projection ? { projection: view.projection } : {}),
    ...(limit ? { limit } : {}),
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

/**
 * One section of a node's relationships, fetched on its own.
 *
 * The node-detail endpoint already returns every section in one round trip, so
 * this exists for the cases where a panel wants *more* of one section than the
 * detail's per-section limit carried — "show all 74 references" — rather than
 * as the normal way to read them.
 */
export async function fetchNodeSection<TNode extends CodeNode | RelatedNode>(
  projectId: string,
  nodeId: string,
  section: NodeSection,
  options: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<TNode[]> {
  const { data } = await api.get<TNode[]>(
    `/api/projects/${projectId}/graph/nodes/${encodeURIComponent(nodeId)}/${section}${queryString({
      ...(options.limit ? { limit: options.limit } : {}),
    })}`,
    signal,
  );
  return data;
}

export type NodeSection =
  | 'callers'
  | 'callees'
  | 'references'
  | 'dependencies'
  | 'dependents'
  | 'parents'
  | 'children'
  | 'implementations';

/** Where a node is written down, for "go to definition". */
export async function fetchDefinition(
  projectId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<Definition | null> {
  const { data } = await api.get<Definition | null>(
    `/api/projects/${projectId}/graph/nodes/${encodeURIComponent(nodeId)}/definition`,
    signal,
  );
  return data;
}

/**
 * One level of the repository tree.
 *
 * A level per request, because the tree is derived from the graph's own file
 * and directory nodes and a large repository has tens of thousands of them.
 * Expanding a folder is what fetches it.
 */
export async function fetchTree(
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<SourceTree> {
  const { data } = await api.get<SourceTree>(
    `/api/projects/${projectId}/graph/tree${queryString(path ? { path } : {})}`,
    signal,
  );
  return data;
}

/**
 * The shortest route between two nodes, found by the server.
 *
 * Server-side because the answer is about the repository, not about the slice
 * on screen: two nodes can be four hops apart in the graph and unconnected in
 * the current view, and the useful answer is the first one.
 */
export async function findPath(
  projectId: string,
  request: {
    from: string;
    to: string;
    maxDepth?: number;
    direction?: 'outgoing' | 'both';
    projection?: GraphProjectionId | null;
  },
  signal?: AbortSignal,
): Promise<GraphPath> {
  const { data } = await api.post<GraphPath>(
    `/api/projects/${projectId}/graph/path`,
    {
      from: request.from,
      to: request.to,
      ...(request.maxDepth ? { maxDepth: request.maxDepth } : {}),
      ...(request.direction ? { direction: request.direction } : {}),
      ...(request.projection ? { projection: request.projection } : {}),
    },
    signal,
  );
  return data;
}
