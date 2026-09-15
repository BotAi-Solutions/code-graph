import { useCallback, useMemo, useRef, useState } from 'react';
import { GRAPH_DEFAULT_DEPTH } from '@ckg/shared';
import { fetchGraph, fetchNodeDetail } from '../../api/graph.api.js';
import { useAsync } from '../../hooks/useAsync.js';
import type {
  CodeEdge,
  CodeGraph,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
} from '../../types/index.js';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas.js';
import { GraphLegend } from './GraphLegend.js';
import { GraphToolbar } from './GraphToolbar.js';
import { NodeInspector } from './NodeInspector.js';
import { defaultPreset } from './view-presets.js';

const EMPTY_GRAPH: CodeGraph = { nodes: [], edges: [] };

export interface CodeGraphPageProps {
  projectId: string;
  /** Bumped by the workspace after an analysis completes, to force a refetch. */
  refreshToken: number;
}

/**
 * The graph workspace: toolbar, canvas and inspector over one project.
 *
 * All view state (root, depth, filters) lives here and is pushed to the API on
 * every change — the canvas renders whatever comes back and the inspector shows
 * whatever the API says about the selection. Nothing is computed client-side
 * from a cached full graph, because there is no full graph on the client.
 */
export function CodeGraphPage({ projectId, refreshToken }: CodeGraphPageProps): React.JSX.Element {
  const [rootNodeId, setRootNodeId] = useState<string | null>(null);
  const [depth, setDepth] = useState(GRAPH_DEFAULT_DEPTH);
  const [nodeTypes, setNodeTypes] = useState<CodeNodeType[]>(() => defaultPreset().nodeTypes);
  const [relationships, setRelationships] = useState<CodeRelationship[]>(
    () => defaultPreset().relationships,
  );

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const canvasRef = useRef<GraphCanvasHandle>(null);

  const graphState = useAsync(
    (signal) =>
      fetchGraph(projectId, { rootNodeId, depth, nodeTypes, relationships }, signal),
    [projectId, rootNodeId, depth, nodeTypes.join(','), relationships.join(','), refreshToken],
  );

  const detailState = useAsync(
    (signal) => fetchNodeDetail(projectId, selectedNodeId as string, signal),
    [projectId, selectedNodeId],
    { enabled: selectedNodeId !== null },
  );

  const graph = graphState.data?.graph ?? EMPTY_GRAPH;
  const meta = graphState.data?.meta ?? null;

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId) return null;
    const edge: CodeEdge | undefined = graph.edges.find((item) => item.id === selectedEdgeId);
    if (!edge) return null;
    return {
      edge,
      source: graph.nodes.find((node) => node.id === edge.sourceNodeId),
      target: graph.nodes.find((node) => node.id === edge.targetNodeId),
    };
  }, [selectedEdgeId, graph]);

  const selectNode = useCallback((nodeId: string) => {
    setSelectedEdgeId(null);
    setSelectedNodeId(nodeId);
    canvasRef.current?.focus(nodeId);
  }, []);

  const expandFrom = useCallback((nodeId: string) => {
    setRootNodeId(nodeId);
    setSelectedEdgeId(null);
    setSelectedNodeId(nodeId);
  }, []);

  const resetView = useCallback(() => {
    setRootNodeId(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setDepth(GRAPH_DEFAULT_DEPTH);
    setNodeTypes(defaultPreset().nodeTypes);
    setRelationships(defaultPreset().relationships);
    canvasRef.current?.reset();
  }, []);

  return (
    <div className="workspace">
      <GraphToolbar
        projectId={projectId}
        depth={depth}
        nodeTypes={nodeTypes}
        relationships={relationships}
        meta={meta}
        loading={graphState.loading}
        onChangeDepth={setDepth}
        onChangeNodeTypes={setNodeTypes}
        onChangeRelationships={setRelationships}
        onSearchSelect={(node: CodeNode) => {
          expandFrom(node.id);
        }}
        onApplyPreset={(nextNodeTypes, nextRelationships) => {
          setNodeTypes(nextNodeTypes);
          setRelationships(nextRelationships);
        }}
        onFit={() => canvasRef.current?.fit()}
        onReset={resetView}
      />

      <div className="workspace__body">
        <div className="workspace__canvas">
          {graphState.error ? (
            <div className="panel panel--error">
              <p>{graphState.error}</p>
              <button type="button" className="button" onClick={graphState.reload}>
                Retry
              </button>
            </div>
          ) : graph.nodes.length === 0 && !graphState.loading ? (
            <div className="panel">
              <p>
                No nodes matched. {rootNodeId ? 'Try a larger depth or fewer filters.' : ''}
              </p>
              {rootNodeId && (
                <button type="button" className="button" onClick={resetView}>
                  Back to overview
                </button>
              )}
            </div>
          ) : (
            <GraphCanvas
              ref={canvasRef}
              graph={graph}
              layout={meta?.mode === 'traversal' ? 'hierarchy' : 'organic'}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onSelectNode={(node) => {
                setSelectedEdgeId(null);
                setSelectedNodeId(node.id);
              }}
              onSelectEdge={(edge) => {
                setSelectedNodeId(null);
                setSelectedEdgeId(edge.id);
              }}
              onExpandNode={(node) => {
                expandFrom(node.id);
              }}
              onClearSelection={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
              }}
            />
          )}

          <GraphLegend />
        </div>

        <NodeInspector
          detail={detailState.data}
          selectedEdge={selectedEdge}
          loading={detailState.loading}
          error={detailState.error}
          onSelectNode={selectNode}
          onExpand={expandFrom}
        />
      </div>
    </div>
  );
}
