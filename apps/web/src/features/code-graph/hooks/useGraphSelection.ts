import { useCallback, useMemo, useState } from 'react';
import { fetchNodeDetail } from '../../../api/graph.api.js';
import { useAsync } from '../../../hooks/useAsync.js';
import type { NodeDetail } from '../../../types/index.js';
import type { CodeGraphModel, GraphEdge, GraphNode } from '../model/graph-types.js';

/**
 * What is selected, and everything the inspector needs about it.
 *
 * Hover is kept here too, but deliberately separate from selection: hovering is
 * a question ("what is this and what touches it") that the canvas answers for
 * itself from the model it already has, and selection is a request ("tell me
 * everything") that costs a round trip. Conflating them would fire a request
 * for every node the cursor crossed.
 */

export interface GraphSelectionState {
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  hoveredNodeId: string | null;
  /** The hovered node, resolved from the model for the tooltip. */
  hoveredNode: GraphNode | null;
  selectedNode: GraphNode | null;
  selectedEdge: { edge: GraphEdge; source: GraphNode | null; target: GraphNode | null } | null;
  detail: NodeDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  selectNode: (nodeId: string) => void;
  selectEdge: (edgeId: string) => void;
  hoverNode: (nodeId: string | null) => void;
  clear: () => void;
}

export function useGraphSelection(
  projectId: string,
  model: CodeGraphModel,
  refreshToken: number,
): GraphSelectionState {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const detailState = useAsync(
    (signal) => fetchNodeDetail(projectId, selectedNodeId as string, signal),
    [projectId, selectedNodeId, refreshToken],
    { enabled: selectedNodeId !== null },
  );

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId) return null;
    const edge = model.edgesById.get(selectedEdgeId);
    if (!edge) return null;

    return {
      edge,
      source: model.nodesById.get(edge.source) ?? null,
      target: model.nodesById.get(edge.target) ?? null,
    };
  }, [selectedEdgeId, model]);

  const selectNode = useCallback((nodeId: string) => {
    setSelectedEdgeId(null);
    setSelectedNodeId(nodeId);
  }, []);

  const selectEdge = useCallback((edgeId: string) => {
    setSelectedNodeId(null);
    setSelectedEdgeId(edgeId);
  }, []);

  const clear = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, []);

  return {
    selectedNodeId,
    selectedEdgeId,
    hoveredNodeId,
    hoveredNode: hoveredNodeId ? (model.nodesById.get(hoveredNodeId) ?? null) : null,
    selectedNode: selectedNodeId ? (model.nodesById.get(selectedNodeId) ?? null) : null,
    selectedEdge,
    detail: detailState.data,
    detailLoading: detailState.loading,
    detailError: detailState.error,
    selectNode,
    selectEdge,
    hoverNode: setHoveredNodeId,
    clear,
  };
}
