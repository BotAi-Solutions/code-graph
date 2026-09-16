import { useCallback, useMemo, useRef, useState } from 'react';
import { GRAPH_DEFAULT_DEPTH } from '@ckg/shared';
import type { CodeNode, CodeNodeType, GraphDirection, GraphSummary } from '../../types/index.js';
import { CodeGraph, type GraphControls } from './components/CodeGraph.js';
import { GraphFilters } from './components/GraphFilters.js';
import { GraphInspector } from './components/GraphInspector.js';
import { GraphLegend } from './components/GraphLegend.js';
import { GraphModes } from './components/GraphModes.js';
import { GraphPathFinder } from './components/GraphPathFinder.js';
import { GraphSearch } from './components/GraphSearch.js';
import { GraphStats } from './components/GraphStats.js';
import { GraphToolbar, type GraphViewToggles } from './components/GraphToolbar.js';
import type { GraphRenderState } from './engine/graph-engine.js';
import { useCodeGraph } from './hooks/useCodeGraph.js';
import { useGraphFocus } from './hooks/useGraphFocus.js';
import { useGraphSearch } from './hooks/useGraphSearch.js';
import { useGraphSelection } from './hooks/useGraphSelection.js';
import { DEFAULT_MODE_ID, graphMode, matchMode, type GraphModeId } from './model/graph-modes.js';
import type { GraphFilterState } from './model/graph-types.js';
import { withinHops } from './utils/graph-traversal.js';

/**
 * The graph workspace: modes, canvas, inspector.
 *
 * All the view state lives here and flows one way — down into the canvas as a
 * finished model plus a render state, down into the panels as props. The canvas
 * never fetches, the panels never compute graph facts, and nothing derives a
 * second copy of the graph.
 *
 * There are two kinds of narrowing and the split is deliberate. Mode, node
 * types, relationships and depth are *queries*: changing one asks the server
 * for a different slice. Modules, externals and focus are *views*: they change
 * what is drawn from the slice already in hand, without a round trip.
 */

export interface GraphWorkspaceProps {
  projectId: string;
  /** Bumped by the page after an analysis completes, to force a refetch. */
  refreshToken: number;
  summary: GraphSummary | null;
  /** Where the analysed repository lives, for the inspector's Open source. */
  repositoryPath: string | null;
  commitHash: string | null;
}

type Panel = 'filters' | 'path' | null;

export function GraphWorkspace({
  projectId,
  refreshToken,
  summary,
  repositoryPath,
  commitHash,
}: GraphWorkspaceProps): React.JSX.Element {
  const [mode, setMode] = useState<GraphModeId | null>(DEFAULT_MODE_ID);
  const [rootNodeId, setRootNodeId] = useState<string | null>(null);
  const [depth, setDepth] = useState(GRAPH_DEFAULT_DEPTH);
  const [direction, setDirection] = useState<GraphDirection>('both');

  const [filters, setFilters] = useState<GraphFilterState>(() => ({
    nodeTypes: [...graphMode(DEFAULT_MODE_ID).projection.nodeTypes],
    relationships: [...graphMode(DEFAULT_MODE_ID).projection.relationships],
    modules: [],
    showExternal: true,
    exportedOnly: false,
    entryPointsOnly: false,
  }));

  const [toggles, setToggles] = useState<GraphViewToggles>({
    labels: true,
    edgeLabels: true,
    animate: true,
    minimap: true,
  });

  const [panel, setPanel] = useState<Panel>(null);
  const [immersive, setImmersive] = useState(false);

  const controls = useRef<GraphControls>(null);

  const view = useCodeGraph({
    projectId,
    mode,
    rootNodeId,
    depth,
    direction,
    nodeTypes: filters.nodeTypes,
    relationships: filters.relationships,
    refreshToken,
    repository: repositoryPath,
    commit: commitHash,
  });

  const { model } = view;

  const selection = useGraphSelection(projectId, model, refreshToken);
  const focus = useGraphFocus(model);
  const search = useGraphSearch(projectId, model);

  const activeMode = mode ? graphMode(mode) : null;
  const matched = matchMode(filters.nodeTypes, filters.relationships);
  const edited = mode !== null && matched === null;

  // --- client-side narrowing ----------------------------------------------

  const visibleNodeIds = useMemo(() => {
    const narrowing =
      filters.modules.length > 0 ||
      !filters.showExternal ||
      filters.exportedOnly ||
      filters.entryPointsOnly;

    if (!narrowing || model.nodes.length === 0) return null;

    const modules = new Set(filters.modules);
    const keep = new Set<string>();

    for (const node of model.nodes) {
      if (!filters.showExternal && node.external) continue;
      if (modules.size > 0 && !modules.has(node.module)) continue;
      if (filters.exportedOnly && !node.exported) continue;
      keep.add(node.id);
    }

    if (filters.entryPointsOnly) {
      // Entry points on their own are a field of disconnected dots. What the
      // filter is actually asking is "where does the system start, and what
      // does it reach first", so one hop comes with them.
      const reachable = new Set<string>();
      for (const node of model.nodes) {
        if (!node.entryPoint || !keep.has(node.id)) continue;
        for (const id of withinHops(model, node.id, 1)) {
          if (keep.has(id)) reachable.add(id);
        }
      }
      keep.clear();
      for (const id of reachable) keep.add(id);
    }

    // Whatever is selected stays visible: a filter that hides the thing the
    // inspector is describing leaves the two panels contradicting each other.
    if (selection.selectedNodeId) keep.add(selection.selectedNodeId);

    return keep;
  }, [model, filters, selection.selectedNodeId]);

  const exportsUnavailable = useMemo(
    () => !model.edges.some((edge) => edge.type === 'EXPORTS'),
    [model],
  );

  const presentNodeIds = useMemo(() => new Set(model.nodesById.keys()), [model]);

  /** What the active mode is about, from the server's own projection. */
  const priorityNodeTypes = useMemo(
    () => new Set<CodeNodeType>(activeMode?.projection.priorityNodeTypes ?? []),
    [activeMode],
  );

  const renderState = useMemo<GraphRenderState>(
    () => ({
      selectedNodeId: selection.selectedNodeId,
      selectedEdgeId: selection.selectedEdgeId,
      hoveredNodeId: selection.hoveredNodeId,
      focusNodeIds: focus.focusNodeIds,
      pathNodeIds: focus.pathNodeIds,
      pathEdgeIds: focus.pathEdgeIds,
      visibleNodeIds,
      expandedNodeIds: view.expandedNodeIds,
      matchedNodeIds: search.matchedNodeIds,
      showLabels: toggles.labels,
      showEdgeLabels: toggles.edgeLabels,
      animate: toggles.animate,
      labelDensity: activeMode?.labelDensity ?? 1,
      priorityNodeTypes,
    }),
    [
      selection.selectedNodeId,
      selection.selectedEdgeId,
      selection.hoveredNodeId,
      focus.focusNodeIds,
      focus.pathNodeIds,
      focus.pathEdgeIds,
      visibleNodeIds,
      view.expandedNodeIds,
      search.matchedNodeIds,
      toggles,
      activeMode,
      priorityNodeTypes,
    ],
  );

  // --- actions ------------------------------------------------------------

  const applyMode = useCallback((id: GraphModeId) => {
    const next = graphMode(id);
    setMode(id);
    setFilters((current) => ({
      ...current,
      nodeTypes: [...next.projection.nodeTypes],
      relationships: [...next.projection.relationships],
      // Module ids are derived per view, so a module chosen in one mode may not
      // exist in the next; dropping the selection is the honest reset.
      modules: [],
    }));
  }, []);

  const reroot = useCallback(
    (nodeId: string) => {
      setRootNodeId(nodeId);
      setDirection('both');
      setDepth(focus.focusDepth);
      view.resetExpansions();
      selection.selectNode(nodeId);
    },
    [focus.focusDepth, view, selection],
  );

  const findReferences = useCallback(
    (nodeId: string) => {
      setRootNodeId(nodeId);
      setMode(null);
      setFilters((current) => ({
        ...current,
        nodeTypes: [],
        relationships: ['REFERENCES', 'CALLS', 'IMPORTS', 'ROUTES_TO', 'USES'],
        modules: [],
      }));
      setDirection('incoming');
      setDepth(1);
      view.resetExpansions();
      selection.selectNode(nodeId);
    },
    [view, selection],
  );

  const onSearchSelect = useCallback(
    (node: CodeNode) => {
      if (model.nodesById.has(node.id)) {
        // Already drawn: this is a camera move and a selection, not a fetch.
        selection.selectNode(node.id);
        controls.current?.focusNode(node.id);
        return;
      }
      // Not in this slice, so the only way to show it is to ask for it.
      reroot(node.id);
    },
    [model, selection, reroot],
  );

  const toggleFocus = useCallback(
    (nodeId: string) => {
      if (focus.focusNodeId === nodeId) {
        focus.setFocus(null);
        controls.current?.fit();
        return;
      }
      focus.setFocus(nodeId);
      controls.current?.frameNodes([...withinHops(model, nodeId, focus.focusDepth)]);
    },
    [focus, model],
  );

  const resetView = useCallback(() => {
    setRootNodeId(null);
    setDepth(GRAPH_DEFAULT_DEPTH);
    setDirection('both');
    setPanel(null);
    selection.clear();
    focus.setFocus(null);
    focus.clearPath();
    search.clear();
    view.resetExpansions();
    applyMode(DEFAULT_MODE_ID);
    controls.current?.reset();
  }, [applyMode, focus, search, selection, view]);

  const onChangeFilters = useCallback((next: GraphFilterState) => {
    setFilters(next);
    // Editing the type or relationship set means the mode no longer describes
    // the view; the mode button stops claiming it does.
    setMode((current) => (current === null ? null : matchMode(next.nodeTypes, next.relationships)));
  }, []);

  const status = view.loading
    ? 'loading…'
    : view.expanding
      ? 'expanding…'
      : view.meta?.mode === 'traversal'
        ? `from root · depth ${String(view.meta.depth)} · ${view.meta.direction}`
        : 'overview';

  return (
    <div className={`workspace${immersive ? ' workspace--immersive' : ''}`}>
      <div className="workbar">
        <GraphSearch search={search} presentNodeIds={presentNodeIds} onSelect={onSearchSelect} />

        <GraphModes active={mode} edited={edited} onChange={applyMode} />

        <button
          type="button"
          className={`button${panel === 'filters' ? ' button--active' : ''}`}
          aria-expanded={panel === 'filters'}
          onClick={() => {
            setPanel((current) => (current === 'filters' ? null : 'filters'));
          }}
        >
          Filters
          {edited && <span className="button__mark" title="Filters edited" />}
        </button>

        <button
          type="button"
          className={`button${panel === 'path' ? ' button--active' : ''}`}
          aria-expanded={panel === 'path'}
          onClick={() => {
            setPanel((current) => (current === 'path' ? null : 'path'));
          }}
        >
          Find path
        </button>

        {(rootNodeId !== null || focus.focusNodeId !== null || view.expandedNodeIds.size > 0) && (
          <button type="button" className="button button--quiet" onClick={resetView}>
            Back to overview
          </button>
        )}

        <div className="workbar__spacer" />

        <GraphStats
          model={model}
          summary={summary}
          truncated={view.meta?.truncated ?? false}
        />

        <span className="workbar__status" title="How this slice was fetched">
          {status}
        </span>
      </div>

      {panel === 'filters' && (
        <GraphFilters
          filters={filters}
          model={model}
          nodeTypeCounts={summary?.nodeTypeCounts}
          relationshipCounts={summary?.relationshipCounts}
          exportsUnavailable={exportsUnavailable}
          onChange={onChangeFilters}
        />
      )}

      {panel === 'path' && (
        <GraphPathFinder
          model={model}
          from={focus.pathFrom}
          to={focus.pathTo}
          path={focus.path}
          selectedNodeId={selection.selectedNodeId}
          onChangeFrom={focus.setPathFrom}
          onChangeTo={focus.setPathTo}
          onSelectNode={(nodeId) => {
            selection.selectNode(nodeId);
            controls.current?.focusNode(nodeId);
          }}
          onClear={focus.clearPath}
        />
      )}

      <div className="workspace__body">
        <div className="workspace__canvas">
          {view.error ? (
            <div className="panel panel--error">
              <p>{view.error}</p>
              <button type="button" className="button" onClick={view.reload}>
                Retry
              </button>
            </div>
          ) : model.nodes.length === 0 && !view.loading ? (
            <div className="panel">
              <p>No nodes matched. {rootNodeId ? 'Try a larger depth or fewer filters.' : ''}</p>
              {rootNodeId && (
                <button type="button" className="button" onClick={resetView}>
                  Back to overview
                </button>
              )}
            </div>
          ) : (
            <CodeGraph
              controlsRef={controls}
              model={model}
              viewKey={view.viewKey}
              renderState={renderState}
              clusterSpread={activeMode?.clusterSpread ?? 1}
              animateFlow={activeMode?.animateFlow ?? true}
              showMinimap={toggles.minimap}
              onSelectNode={selection.selectNode}
              onSelectEdge={selection.selectEdge}
              onExpandNode={view.expandNode}
              onHoverNode={selection.hoverNode}
              onClearSelection={selection.clear}
            />
          )}

          <GraphToolbar
            toggles={toggles}
            selectedNodeId={selection.selectedNodeId}
            fullscreen={immersive}
            onZoomIn={() => controls.current?.zoomIn()}
            onZoomOut={() => controls.current?.zoomOut()}
            onFit={() => controls.current?.fit()}
            onCenterSelection={() => {
              if (selection.selectedNodeId) controls.current?.focusNode(selection.selectedNodeId);
            }}
            onReset={resetView}
            onToggle={(key) => {
              setToggles((current) => ({ ...current, [key]: !current[key] }));
            }}
            onToggleFullscreen={() => {
              setImmersive((current) => !current);
            }}
          />

          <GraphLegend />
        </div>

        <GraphInspector
          model={model}
          node={selection.selectedNode}
          detail={selection.detail}
          selectedEdge={selection.selectedEdge}
          loading={selection.detailLoading}
          error={selection.detailError}
          repositoryPath={repositoryPath}
          expanded={
            selection.selectedNodeId !== null &&
            view.expandedNodeIds.has(selection.selectedNodeId)
          }
          focused={focus.focusNodeId === selection.selectedNodeId && focus.focusNodeId !== null}
          focusDepth={focus.focusDepth}
          onSelectNode={(nodeId) => {
            selection.selectNode(nodeId);
            if (model.nodesById.has(nodeId)) controls.current?.focusNode(nodeId);
          }}
          onExpand={view.expandNode}
          onToggleFocus={toggleFocus}
          onChangeFocusDepth={focus.setFocusDepth}
          onReroot={reroot}
          onFindReferences={findReferences}
          onPathFrom={(nodeId) => {
            focus.setPathFrom(nodeId);
            setPanel('path');
          }}
          onPathTo={(nodeId) => {
            focus.setPathTo(nodeId);
            setPanel('path');
          }}
        />
      </div>
    </div>
  );
}
