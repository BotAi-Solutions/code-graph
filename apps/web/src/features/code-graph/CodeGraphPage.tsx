import { useCallback, useMemo, useRef, useState } from 'react';
import { GRAPH_DEFAULT_DEPTH, GRAPH_EXPANSION_DEPTH } from '@ckg/shared';
import { fetchGraph, fetchNeighbourhood, fetchNodeDetail } from '../../api/graph.api.js';
import { useAsync } from '../../hooks/useAsync.js';
import type {
  CodeEdge,
  CodeGraph,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  GraphDirection,
  GraphProjectionId,
  GraphSummary,
} from '../../types/index.js';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas.js';
import { GraphLegend } from './GraphLegend.js';
import { GraphToolbar } from './GraphToolbar.js';
import { NodeInspector } from './NodeInspector.js';
import { mergeGraphs } from './merge-graph.js';
import { defaultPreset, presetById } from './view-presets.js';

const EMPTY_GRAPH: CodeGraph = { nodes: [], edges: [] };

export interface CodeGraphPageProps {
  projectId: string;
  /** Bumped by the workspace after an analysis completes, to force a refetch. */
  refreshToken: number;
  summary: GraphSummary | null;
  /** Where the analysed repository lives, for the inspector's Open source. */
  repositoryPath: string | null;
}

/**
 * The graph workspace: toolbar, canvas and inspector over one project.
 *
 * View state (root, depth, projection, filters) lives here and is pushed to the
 * API on every change — the canvas renders whatever comes back and the inspector
 * shows whatever the API says about the selection. Nothing is computed
 * client-side from a cached full graph, because there is no full graph on the
 * client.
 *
 * Exploration is progressive. The base view is one traversal or the overview;
 * expanding a node fetches *its* neighbourhood and merges it in, so the canvas
 * grows by the handful of nodes the user asked for rather than by re-rooting and
 * discarding what they were looking at. Re-rooting is still available, as
 * Focus, because the two are different intentions.
 */
export function CodeGraphPage({
  projectId,
  refreshToken,
  summary,
  repositoryPath,
}: CodeGraphPageProps): React.JSX.Element {
  const [rootNodeId, setRootNodeId] = useState<string | null>(null);
  const [depth, setDepth] = useState(GRAPH_DEFAULT_DEPTH);
  const [direction, setDirection] = useState<GraphDirection>('both');
  const [projection, setProjection] = useState<GraphProjectionId | null>(defaultPreset().id);
  const [nodeTypes, setNodeTypes] = useState<CodeNodeType[]>(() => [...defaultPreset().nodeTypes]);
  const [relationships, setRelationships] = useState<CodeRelationship[]>(() => [
    ...defaultPreset().relationships,
  ]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  /** Neighbourhoods the user has pulled in, keyed by the node expanded. */
  const [expansions, setExpansions] = useState<ReadonlyMap<string, CodeGraph>>(new Map());
  const [expanding, setExpanding] = useState(false);

  const canvasRef = useRef<GraphCanvasHandle>(null);

  const graphState = useAsync(
    (signal) =>
      fetchGraph(
        projectId,
        { rootNodeId, depth, projection, nodeTypes, relationships, direction },
        signal,
      ),
    [
      projectId,
      rootNodeId,
      depth,
      direction,
      projection,
      nodeTypes.join(','),
      relationships.join(','),
      refreshToken,
    ],
  );

  const detailState = useAsync(
    (signal) => fetchNodeDetail(projectId, selectedNodeId as string, signal),
    [projectId, selectedNodeId, refreshToken],
    { enabled: selectedNodeId !== null },
  );

  const base = graphState.data?.graph ?? EMPTY_GRAPH;
  const meta = graphState.data?.meta ?? null;

  /** What the canvas draws: the base view plus every expansion. */
  const graph = useMemo(
    () => (expansions.size === 0 ? base : mergeGraphs(base, ...expansions.values())),
    [base, expansions],
  );

  const expandedNodeIds = useMemo(() => new Set(expansions.keys()), [expansions]);

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

  /** Pull a node's neighbours onto the canvas, keeping what is already there. */
  const expandNode = useCallback(
    (nodeId: string) => {
      if (expansions.has(nodeId)) {
        // Already expanded: centre it rather than fetching the same nodes again.
        canvasRef.current?.focus(nodeId);
        return;
      }

      setExpanding(true);
      fetchNeighbourhood(
        projectId,
        nodeId,
        { projection, nodeTypes, relationships },
        { depth: GRAPH_EXPANSION_DEPTH },
      )
        .then((result) => {
          setExpansions((current) => new Map(current).set(nodeId, result.graph));
          setSelectedNodeId(nodeId);
          setSelectedEdgeId(null);
        })
        .catch(() => {
          // The base view is unaffected by a failed expansion; the node simply
          // stays unexpanded, and the status line still reflects reality.
        })
        .finally(() => {
          setExpanding(false);
        });
    },
    [expansions, projectId, projection, nodeTypes, relationships],
  );

  /** Start again from this node: a new traversal, expansions discarded. */
  const focusNode = useCallback((nodeId: string) => {
    setRootNodeId(nodeId);
    setExpansions(new Map());
    setDirection('both');
    setSelectedEdgeId(null);
    setSelectedNodeId(nodeId);
  }, []);

  /** Everything that points at this node, whatever the current projection. */
  const findReferences = useCallback((nodeId: string) => {
    setRootNodeId(nodeId);
    setExpansions(new Map());
    setProjection(null);
    setNodeTypes([]);
    setRelationships(['REFERENCES', 'CALLS', 'IMPORTS', 'ROUTES_TO', 'USES']);
    setDirection('incoming');
    setDepth(1);
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
  }, []);

  const applyPreset = useCallback((id: GraphProjectionId) => {
    const preset = presetById(id);
    setProjection(id);
    setNodeTypes([...preset.nodeTypes]);
    setRelationships([...preset.relationships]);
  }, []);

  const resetView = useCallback(() => {
    setRootNodeId(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setExpansions(new Map());
    setDepth(GRAPH_DEFAULT_DEPTH);
    setDirection('both');
    applyPreset(defaultPreset().id);
    canvasRef.current?.reset();
  }, [applyPreset]);

  const displayedMeta = meta
    ? { ...meta, nodeCount: graph.nodes.length, edgeCount: graph.edges.length }
    : null;

  return (
    <div className="workspace">
      <GraphToolbar
        projectId={projectId}
        depth={depth}
        projection={projection}
        nodeTypes={nodeTypes}
        relationships={relationships}
        meta={displayedMeta}
        summary={summary}
        loading={graphState.loading || expanding}
        expandedCount={expansions.size}
        onChangeDepth={setDepth}
        onChangeNodeTypes={(next) => {
          setNodeTypes(next);
        }}
        onChangeRelationships={(next) => {
          setRelationships(next);
        }}
        onSearchSelect={(node: CodeNode) => {
          focusNode(node.id);
        }}
        onApplyPreset={applyPreset}
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
              <p>No nodes matched. {rootNodeId ? 'Try a larger depth or fewer filters.' : ''}</p>
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
              expandedNodeIds={expandedNodeIds}
              onSelectNode={(node) => {
                setSelectedEdgeId(null);
                setSelectedNodeId(node.id);
              }}
              onSelectEdge={(edge) => {
                setSelectedNodeId(null);
                setSelectedEdgeId(edge.id);
              }}
              onExpandNode={(node) => {
                expandNode(node.id);
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
          repositoryPath={repositoryPath}
          expanded={selectedNodeId !== null && expansions.has(selectedNodeId)}
          onSelectNode={selectNode}
          onExpand={expandNode}
          onFocus={focusNode}
          onFindReferences={findReferences}
        />
      </div>
    </div>
  );
}
