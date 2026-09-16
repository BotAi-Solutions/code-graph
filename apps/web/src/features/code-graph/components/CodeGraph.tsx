import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { CodeGraphModel, GraphNode } from '../model/graph-types.js';
import type { DetailLevel } from '../engine/label-engine.js';
import { GraphEngine, type GraphRenderState } from '../engine/graph-engine.js';
import { GraphMinimap } from './GraphMinimap.js';
import { GraphTooltip } from './GraphTooltip.js';

/**
 * The canvas.
 *
 * A single `<div>` that Sigma owns, plus two pieces of chrome that need
 * viewport coordinates — the tooltip and the minimap. Everything else about the
 * graph lives in the engine, which is created once and never recreated: new
 * data, new selection and new filters are all pushed into it imperatively.
 *
 * That is the point of this component. It has no per-node state, renders no
 * element per node, and does not re-render when the camera moves or when the
 * cursor crosses a node — a hover changes one field on the engine and one small
 * tooltip, not a tree of two thousand components.
 */

export interface GraphControls {
  fit: () => void;
  reset: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  focusNode: (nodeId: string) => void;
  frameNodes: (nodeIds: readonly string[]) => void;
}

export interface CodeGraphProps {
  model: CodeGraphModel;
  /** Changes when the base view changes; stable across expansions. */
  viewKey: string;
  renderState: GraphRenderState;
  clusterSpread: number;
  animateFlow: boolean;
  showMinimap: boolean;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
  onExpandNode: (nodeId: string) => void;
  onHoverNode: (nodeId: string | null) => void;
  onClearSelection: () => void;
  onDetailLevelChange?: (level: DetailLevel) => void;
  controlsRef?: Ref<GraphControls>;
}

interface TooltipState {
  node: GraphNode;
  x: number;
  y: number;
}

export function CodeGraph({
  model,
  viewKey,
  renderState,
  clusterSpread,
  animateFlow,
  showMinimap,
  onSelectNode,
  onSelectEdge,
  onExpandNode,
  onHoverNode,
  onClearSelection,
  onDetailLevelChange,
  controlsRef,
}: CodeGraphProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  /**
   * Bumped whenever the engine has painted something new — a camera move or a
   * fresh model. The minimap is the only thing in React that has to follow the
   * camera, and this is how it hears about it without subscribing to Sigma.
   */
  const [renderTick, setRenderTick] = useState(0);

  /**
   * Handlers change identity on every parent render; a ref keeps the engine's
   * listeners stable so Sigma is built once rather than on each update.
   */
  const handlers = useRef({
    onSelectNode,
    onSelectEdge,
    onExpandNode,
    onHoverNode,
    onClearSelection,
    onDetailLevelChange,
  });
  handlers.current = {
    onSelectNode,
    onSelectEdge,
    onExpandNode,
    onHoverNode,
    onClearSelection,
    onDetailLevelChange,
  };

  const hoveredRef = useRef<string | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;

  const placeTooltip = useCallback((nodeId: string | null) => {
    const engine = engineRef.current;
    if (!engine || !nodeId) {
      setTooltip(null);
      return;
    }

    const node = modelRef.current.nodesById.get(nodeId);
    const position = engine.nodeViewportPosition(nodeId);
    if (!node || !position) {
      setTooltip(null);
      return;
    }

    setTooltip({ node, x: position.x, y: position.y });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const engine = new GraphEngine(container, {
      onSelectNode: (nodeId) => {
        handlers.current.onSelectNode(nodeId);
      },
      onSelectEdge: (edgeId) => {
        handlers.current.onSelectEdge(edgeId);
      },
      onExpandNode: (nodeId) => {
        handlers.current.onExpandNode(nodeId);
      },
      onHoverNode: (nodeId) => {
        hoveredRef.current = nodeId;
        handlers.current.onHoverNode(nodeId);
        placeTooltip(nodeId);
      },
      onClearSelection: () => {
        handlers.current.onClearSelection();
      },
      onCameraChange: ({ detailLevel }) => {
        handlers.current.onDetailLevelChange?.(detailLevel);
        // The minimap's viewport rectangle and the tooltip's anchor both move
        // with the camera, and nothing else in React does.
        setRenderTick((tick) => tick + 1);
        if (hoveredRef.current) placeTooltip(hoveredRef.current);
      },
    });

    engineRef.current = engine;
    setEngineReady(true);

    const observer = new ResizeObserver(() => {
      engine.resize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      engine.kill();
      engineRef.current = null;
      setEngineReady(false);
    };
  }, [placeTooltip]);

  /**
   * New data. Positions are kept when only an expansion happened, so the
   * picture grows instead of being rebuilt underneath the reader.
   */
  const previousViewKey = useRef<string | null>(null);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const preservePositions = previousViewKey.current === viewKey;
    previousViewKey.current = viewKey;

    engine.setModel(model, { preservePositions, clusterSpread, animateFlow });

    // Sigma only has display coordinates once it has processed the new graph,
    // and a fresh view does not necessarily move the camera — it opens at the
    // default state — so the minimap would otherwise never hear that there is
    // anything to draw.
    setRenderTick((tick) => tick + 1);
  }, [model, viewKey, clusterSpread, animateFlow]);

  /** Selection, hover, focus and filters: a style pass, never a re-layout. */
  useEffect(() => {
    engineRef.current?.setRenderState(renderState);
  }, [renderState]);

  useImperativeHandle(
    controlsRef,
    (): GraphControls => ({
      fit: () => engineRef.current?.fit(),
      reset: () => engineRef.current?.resetView(),
      zoomIn: () => engineRef.current?.zoomBy(1 / 1.45),
      zoomOut: () => engineRef.current?.zoomBy(1.45),
      focusNode: (nodeId) => engineRef.current?.focusNode(nodeId),
      frameNodes: (nodeIds) => engineRef.current?.frameNodes(nodeIds),
    }),
    [],
  );

  return (
    <div className="graph-stage">
      <div className="graph-stage__space" aria-hidden="true" />
      <div
        className="graph-stage__canvas"
        ref={containerRef}
        role="application"
        aria-label="Code graph"
      />

      {tooltip && <GraphTooltip node={tooltip.node} x={tooltip.x} y={tooltip.y} />}

      {showMinimap && engineReady && engineRef.current && (
        <GraphMinimap
          engine={engineRef.current}
          model={model}
          selectedNodeId={renderState.selectedNodeId}
          tick={renderTick}
        />
      )}
    </div>
  );
}
