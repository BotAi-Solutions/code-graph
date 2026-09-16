import { useCallback, useMemo, useState } from 'react';
import { GRAPH_EXPANSION_DEPTH } from '@ckg/shared';
import { fetchGraph, fetchNeighbourhood } from '../../../api/graph.api.js';
import { useAsync } from '../../../hooks/useAsync.js';
import type {
  CodeGraph,
  CodeNodeType,
  CodeRelationship,
  GraphDirection,
  GraphMeta,
} from '../../../types/index.js';
import { EMPTY_MODEL, type CodeGraphModel } from '../model/graph-types.js';
import { normalizeGraph } from '../model/graph-transform.js';
import { mergeGraphs } from '../model/merge-graph.js';
import { graphMode, type GraphModeId } from '../model/graph-modes.js';

/**
 * The graph the workspace is looking at.
 *
 * Fetching, expansion and normalisation in one place, so every component below
 * receives a finished `CodeGraphModel` and none of them knows that the server
 * answers in a different shape or that the picture is assembled from more than
 * one request.
 *
 * Exploration is progressive, as it was before: the base view is one traversal
 * or the project overview, and expanding a node fetches *its* neighbourhood and
 * merges it in. The canvas therefore grows by the handful of nodes the user
 * asked for rather than by re-rooting and discarding what they were reading.
 */

export interface CodeGraphParams {
  projectId: string;
  mode: GraphModeId | null;
  rootNodeId: string | null;
  depth: number;
  direction: GraphDirection;
  nodeTypes: CodeNodeType[];
  relationships: CodeRelationship[];
  /** Bumped after an analysis completes, to force a refetch. */
  refreshToken: number;
  repository: string | null;
  commit: string | null;
  /**
   * Nodes and edges to draw alongside the fetched view, whatever the filters.
   *
   * A found path is the case this exists for: the server walks the whole
   * repository, so a route routinely passes through nodes the current
   * projection is not drawing — and a path you cannot see is not an answer.
   */
  overlay?: CodeGraph | null;
}

export interface CodeGraphView {
  model: CodeGraphModel;
  meta: GraphMeta | null;
  loading: boolean;
  expanding: boolean;
  error: string | null;
  expandedNodeIds: ReadonlySet<string>;
  /**
   * Identity of the *base* view. It changes when the query changes and not
   * when a neighbourhood is expanded, which is how the canvas knows whether to
   * keep the positions the user was looking at.
   */
  viewKey: string;
  reload: () => void;
  expandNode: (nodeId: string, depth?: number) => void;
  resetExpansions: () => void;
}

const EMPTY_GRAPH: CodeGraph = { nodes: [], edges: [] };

export function useCodeGraph(params: CodeGraphParams): CodeGraphView {
  const [expansions, setExpansions] = useState<ReadonlyMap<string, CodeGraph>>(new Map());
  const [expanding, setExpanding] = useState(false);

  const mode = params.mode ? graphMode(params.mode) : null;
  const limit = mode?.limit;

  const graphState = useAsync(
    (signal) =>
      fetchGraph(
        params.projectId,
        {
          rootNodeId: params.rootNodeId,
          depth: params.depth,
          projection: params.mode,
          nodeTypes: params.nodeTypes,
          relationships: params.relationships,
          direction: params.direction,
        },
        signal,
        limit,
      ),
    [
      params.projectId,
      params.rootNodeId,
      params.depth,
      params.direction,
      params.mode,
      params.nodeTypes.join(','),
      params.relationships.join(','),
      params.refreshToken,
      limit,
    ],
  );

  const base = graphState.data?.graph ?? EMPTY_GRAPH;
  const meta = graphState.data?.meta ?? null;

  /** The base view, every expansion and any overlay, merged by id. */
  const overlay = params.overlay ?? null;
  const graph = useMemo(() => {
    const extra = [...expansions.values(), ...(overlay ? [overlay] : [])];
    return extra.length === 0 ? base : mergeGraphs(base, ...extra);
  }, [base, expansions, overlay]);

  /**
   * Normalisation is the expensive step — degree, PageRank, modules — so it is
   * memoised on the merged graph alone. Selecting, hovering and filtering never
   * reach it.
   */
  const model = useMemo(
    () =>
      graph.nodes.length === 0
        ? EMPTY_MODEL
        : normalizeGraph(graph, { repository: params.repository, commit: params.commit }),
    [graph, params.repository, params.commit],
  );

  const expandedNodeIds = useMemo(
    () => new Set([...expansions.keys()].map((key) => key.slice(0, key.lastIndexOf('@')))),
    [expansions],
  );

  const viewKey = [
    params.projectId,
    params.rootNodeId ?? '',
    String(params.depth),
    params.direction,
    params.mode ?? '',
    params.nodeTypes.join('|'),
    params.relationships.join('|'),
    String(params.refreshToken),
  ].join('/');

  const expandNode = useCallback(
    (nodeId: string, depth: number = GRAPH_EXPANSION_DEPTH) => {
      // Keyed by node *and* depth: expanding to two hops after one has to be
      // able to fetch, rather than being mistaken for the expansion already
      // held. Merging is by id, so the overlap costs nothing.
      const key = `${nodeId}@${String(depth)}`;
      if (expansions.has(key)) return;

      setExpanding(true);
      fetchNeighbourhood(
        params.projectId,
        nodeId,
        {
          projection: params.mode,
          nodeTypes: params.nodeTypes,
          relationships: params.relationships,
        },
        { depth },
      )
        .then((result) => {
          setExpansions((current) => new Map(current).set(key, result.graph));
        })
        .catch(() => {
          // A failed expansion leaves the base view untouched: the node simply
          // stays unexpanded, and the status line still reflects reality.
        })
        .finally(() => {
          setExpanding(false);
        });
    },
    [expansions, params.projectId, params.mode, params.nodeTypes, params.relationships],
  );

  const resetExpansions = useCallback(() => {
    setExpansions(new Map());
  }, []);

  return {
    model,
    meta,
    loading: graphState.loading,
    expanding,
    error: graphState.error,
    expandedNodeIds,
    viewKey,
    reload: graphState.reload,
    expandNode,
    resetExpansions,
  };
}
