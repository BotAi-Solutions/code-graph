import Graph from 'graphology';
import Sigma from 'sigma';
import { EdgeArrowProgram, EdgeRectangleProgram } from 'sigma/rendering';
import type { Attributes } from 'graphology-types';
import type { EdgeDisplayData, NodeDisplayData } from 'sigma/types';
import type { CodeGraphModel, GraphEdge, GraphNode } from '../model/graph-types.js';
import { edgeStyle } from '../model/edge-types.js';
import { NODE_SHAPES, nodeStyle } from '../model/node-types.js';
import { ACCENT, CANVAS_INK, PATH_ACCENT, brighten, dim } from '../utils/graph-colors.js';
import { detectClusters, type ClusterLayout } from './cluster-engine.js';
import {
  detailLevelFor,
  drawCodeNodeHover,
  drawCodeNodeLabel,
  inDetailScope,
  labelFor,
  labelPlacement,
  NO_PRIORITY,
  type DetailLevel,
  type PriorityTypes,
} from './label-engine.js';
import { applyLayout, refineLayout, seedPositions } from './layout-engine.js';
import { NodeGlowProgram, type CodeNodeDisplayData } from './node-programs.js';
import { ParticleEngine } from './particle-engine.js';

/**
 * The renderer.
 *
 * This class owns the Graphology graph, the Sigma instance, the layout and the
 * render state, and it owns them *outside* React. That separation is the
 * performance story of the whole feature: hovering a node in a graph of ten
 * thousand does not re-render a component tree, it mutates a field on this
 * object and asks Sigma for one more frame. React is left with what it is good
 * at — the toolbar, the filters, the inspector, the URL — and never learns
 * where a node is.
 *
 * The contract with React is small on purpose:
 *
 * - `setModel` hands over a new normalised graph (a new view, or an expansion);
 * - `setRenderState` hands over what is selected, hovered, focused or filtered;
 * - callbacks go the other way when the user clicks, hovers or moves the camera.
 *
 * Nothing else crosses the boundary, and nothing in here imports React.
 */

export interface GraphRenderState {
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  hoveredNodeId: string | null;
  /** Focus mode: only these are drawn. Null means no focus. */
  focusNodeIds: ReadonlySet<string> | null;
  /** Path finder: these stay lit and everything else fades. */
  pathNodeIds: ReadonlySet<string> | null;
  pathEdgeIds: ReadonlySet<string> | null;
  /** Client-side filters. Null means nothing is filtered out. */
  visibleNodeIds: ReadonlySet<string> | null;
  /** Neighbourhoods already pulled in, drawn with a ring. */
  expandedNodeIds: ReadonlySet<string>;
  /** Search matches, lit so they can be found without being selected. */
  matchedNodeIds: ReadonlySet<string> | null;
  showLabels: boolean;
  showEdgeLabels: boolean;
  animate: boolean;
  /** From the graph mode. */
  labelDensity: number;
  /** Node types the active mode is about; they stay in scope at any zoom. */
  priorityNodeTypes: PriorityTypes;
}

export interface GraphEngineCallbacks {
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
  onExpandNode: (nodeId: string) => void;
  onHoverNode: (nodeId: string | null) => void;
  onClearSelection: () => void;
  onCameraChange: (state: { ratio: number; detailLevel: DetailLevel }) => void;
}

export interface SetModelOptions {
  /** Keeps existing nodes where they are: this is an expansion, not a reload. */
  preservePositions: boolean;
  clusterSpread: number;
  animateFlow: boolean;
}

const DEFAULT_STATE: GraphRenderState = {
  selectedNodeId: null,
  selectedEdgeId: null,
  hoveredNodeId: null,
  focusNodeIds: null,
  pathNodeIds: null,
  pathEdgeIds: null,
  visibleNodeIds: null,
  expandedNodeIds: new Set(),
  matchedNodeIds: null,
  showLabels: true,
  showEdgeLabels: true,
  animate: true,
  labelDensity: 1,
  priorityNodeTypes: NO_PRIORITY,
};

/** How long an expansion takes to fly its new nodes into place. */
const EXPAND_ANIMATION_MS = 620;
/** Above this, expansion snaps: animating it would cost more than it says. */
const ANIMATION_NODE_CEILING = 2500;

const MONO_FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export class GraphEngine {
  private readonly graph: Graph;
  private readonly sigma: Sigma;
  private readonly particles: ParticleEngine;

  private model: CodeGraphModel | null = null;
  private clusters: ClusterLayout | null = null;
  private state: GraphRenderState = DEFAULT_STATE;
  private detailLevel: DetailLevel = 'overview';

  /** Recomputed only when the hover or selection changes, not per node. */
  private attentionNodes: ReadonlySet<string> | null = null;
  private attentionEdges: ReadonlySet<string> | null = null;

  private animationFrame: number | null = null;
  private refreshFrame: number | null = null;
  private cameraFrame: number | null = null;

  constructor(
    container: HTMLElement,
    private readonly callbacks: GraphEngineCallbacks,
  ) {
    this.graph = new Graph({ type: 'directed', multi: true });

    this.sigma = new Sigma(this.graph, container, {
      // One WebGL program draws every silhouette and every halo; see
      // `node-programs.ts` for why Sigma's circles were not enough.
      defaultNodeType: 'code',
      nodeProgramClasses: { code: NodeGlowProgram },
      defaultEdgeType: 'arrow',
      edgeProgramClasses: { arrow: EdgeArrowProgram, line: EdgeRectangleProgram },

      defaultDrawNodeLabel: drawCodeNodeLabel,
      defaultDrawNodeHover: drawCodeNodeHover,

      labelFont: MONO_FONT,
      labelSize: 11,
      labelWeight: '500',
      labelColor: { color: '#c7d2e0' },
      edgeLabelFont: MONO_FONT,
      edgeLabelSize: 9,
      edgeLabelColor: { color: '#8595ad' },

      // The label grid keeps one label per cell and prefers the biggest node in
      // it. Since size already encodes importance, collision avoidance and
      // label priority end up being the same mechanism.
      labelGridCellSize: 110,
      labelDensity: 0.9,
      labelRenderedSizeThreshold: 1.5,

      renderEdgeLabels: true,
      enableEdgeEvents: true,
      // Sigma clamps every edge to this. The default of 1.7px is thicker than
      // a weak edge is supposed to be, which silently flattens the three
      // emphasis tiers into one.
      minEdgeThickness: 0.7,
      // Edges are the expensive half of a large graph and the half nobody reads
      // mid-pan; dropping them while the camera moves is what keeps dragging
      // smooth at ten thousand nodes.
      hideEdgesOnMove: true,
      hideLabelsOnMove: true,

      zIndex: true,
      stagePadding: 70,
      minCameraRatio: 0.03,
      maxCameraRatio: 12,
      allowInvalidContainer: true,

      nodeReducer: this.reduceNode,
      edgeReducer: this.reduceEdge,
    });

    this.particles = new ParticleEngine(this.sigma);

    this.bindEvents();
  }

  // --- data ---------------------------------------------------------------

  /**
   * Replaces what is drawn.
   *
   * With `preservePositions` the nodes already on screen keep their coordinates
   * and only the new ones are placed, so expanding a neighbourhood grows the
   * picture the user was reading instead of rearranging it — which is the
   * difference between exploration and a page reload.
   */
  setModel(model: CodeGraphModel, options: SetModelOptions): void {
    const previous = options.preservePositions ? this.capturePositions() : new Map();

    this.model = model;
    this.clusters = detectClusters(model, { spread: options.clusterSpread });

    const seeds = seedPositions(model, this.clusters);
    const arriving: string[] = [];

    this.graph.clear();

    for (const node of model.nodes) {
      const held = previous.get(node.id);
      if (!held) arriving.push(node.id);

      const position = held ?? seeds.get(node.id) ?? { x: 0, y: 0 };

      this.graph.addNode(node.id, {
        x: position.x,
        y: position.y,
        size: baseSizeOf(node),
        label: node.label,
        color: nodeStyle(node.type).color,
        type: 'code',
      });
    }

    for (const edge of model.edges) {
      // A multi graph, because two symbols can be related in more than one way
      // and collapsing CALLS and REFERENCES into one line would lose the
      // evidence behind each of them.
      if (!this.graph.hasNode(edge.source) || !this.graph.hasNode(edge.target)) continue;
      this.graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
        size: edgeStyle(edge.type).width,
        color: edgeStyle(edge.type).color,
        type: edgeStyle(edge.type).program,
      });
    }

    if (previous.size === 0) {
      applyLayout(this.graph, model, this.clusters, { clusterSpread: options.clusterSpread });
      this.particles.setGraph(model, { animate: this.state.animate && options.animateFlow });
      this.sigma.refresh();
      this.fit(false);
      return;
    }

    this.growInto(model, arriving, previous, options);
  }

  /**
   * Places the nodes an expansion brought in, then animates everything to rest.
   *
   * New nodes start at the centre of gravity of whichever neighbours are
   * already on screen — the node that was double-clicked, usually — so they
   * appear to come *out of* it rather than to fade in from nowhere.
   */
  private growInto(
    model: CodeGraphModel,
    arriving: readonly string[],
    previous: ReadonlyMap<string, { x: number; y: number }>,
    options: SetModelOptions,
  ): void {
    for (const id of arriving) {
      const anchor = this.anchorFor(model, id, previous);
      if (!anchor) continue;
      this.graph.setNodeAttribute(id, 'x', anchor.x);
      this.graph.setNodeAttribute(id, 'y', anchor.y);
    }

    const from = this.capturePositions();

    if (this.clusters) refineLayout(this.graph, model, this.clusters);

    const to = this.capturePositions();
    this.particles.setGraph(model, { animate: this.state.animate && options.animateFlow });

    if (arriving.length === 0 || this.graph.order > ANIMATION_NODE_CEILING) {
      this.sigma.refresh();
      return;
    }

    this.animatePositions(from, to);
  }

  private anchorFor(
    model: CodeGraphModel,
    nodeId: string,
    placed: ReadonlyMap<string, { x: number; y: number }>,
  ): { x: number; y: number } | null {
    let x = 0;
    let y = 0;
    let count = 0;

    for (const neighbour of model.adjacency.get(nodeId) ?? []) {
      const position = placed.get(neighbour);
      if (!position) continue;
      x += position.x;
      y += position.y;
      count += 1;
    }

    if (count === 0) return null;

    // A tiny deterministic offset keeps siblings from landing on exactly the
    // same pixel, which the force pass would then have to untangle.
    const jitter = (nodeId.length % 7) - 3;
    return { x: x / count + jitter, y: y / count - jitter };
  }

  private animatePositions(
    from: ReadonlyMap<string, { x: number; y: number }>,
    to: ReadonlyMap<string, { x: number; y: number }>,
  ): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);

    const start = performance.now();

    const step = (now: number): void => {
      const progress = Math.min(1, (now - start) / EXPAND_ANIMATION_MS);
      // Ease-out cubic: fast enough to feel immediate, slow enough at the end
      // that the eye can follow where a node came from.
      const eased = 1 - Math.pow(1 - progress, 3);

      // One pass over the attributes emits one update event, rather than one
      // per node per frame.
      this.graph.updateEachNodeAttributes(
        (node, attributes) => {
          const a = from.get(node);
          const b = to.get(node);
          if (!a || !b) return attributes;
          return {
            ...attributes,
            x: a.x + (b.x - a.x) * eased,
            y: a.y + (b.y - a.y) * eased,
          };
        },
        { attributes: ['x', 'y'] },
      );

      if (progress < 1) {
        this.animationFrame = requestAnimationFrame(step);
      } else {
        this.animationFrame = null;
      }
    };

    this.animationFrame = requestAnimationFrame(step);
  }

  private capturePositions(): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>();
    this.graph.forEachNode((node, attributes) => {
      positions.set(node, { x: attributes.x as number, y: attributes.y as number });
    });
    return positions;
  }

  // --- render state -------------------------------------------------------

  setRenderState(state: GraphRenderState): void {
    const previous = this.state;
    this.state = state;

    this.attentionNodes = null;
    this.attentionEdges = null;

    const anchor = state.hoveredNodeId ?? state.selectedNodeId;
    if (anchor && this.model) {
      const nodes = new Set<string>([anchor]);
      const edges = new Set<string>();

      for (const edge of this.model.edges) {
        if (edge.source === anchor) {
          nodes.add(edge.target);
          edges.add(edge.id);
        } else if (edge.target === anchor) {
          nodes.add(edge.source);
          edges.add(edge.id);
        }
      }

      this.attentionNodes = nodes;
      this.attentionEdges = edges;
    }

    if (state.animate !== previous.animate && this.model) {
      this.particles.setGraph(this.model, { animate: state.animate });
    }

    // Sizes change with selection and focus, so the label grid has to be
    // rebuilt; hover alone never does, and skipping indexation there is what
    // keeps a mouse sweep across a dense cluster free.
    const hoverOnly =
      state.selectedNodeId === previous.selectedNodeId &&
      state.selectedEdgeId === previous.selectedEdgeId &&
      state.focusNodeIds === previous.focusNodeIds &&
      state.visibleNodeIds === previous.visibleNodeIds &&
      state.pathNodeIds === previous.pathNodeIds;

    this.scheduleRefresh(hoverOnly);
  }

  private scheduleRefresh(skipIndexation: boolean): void {
    if (this.refreshFrame !== null) return;

    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = null;
      this.sigma.refresh({ skipIndexation });
    });
  }

  // --- reducers -----------------------------------------------------------

  /**
   * Everything the renderer decides about one node, per frame.
   *
   * Sigma requires a reducer to return a *total* object, so the spread is not
   * optional — leaving a key out would drop the attribute rather than keep it.
   */
  private readonly reduceNode = (id: string, data: Attributes): Partial<NodeDisplayData> => {
    const node = this.model?.nodesById.get(id);
    const result = { ...data } as CodeNodeDisplayData;

    if (!node) return result;

    const state = this.state;

    if (state.visibleNodeIds && !state.visibleNodeIds.has(id)) {
      result.hidden = true;
      return result;
    }

    // Focus hides rather than dims. Dimming keeps the shape of the graph, which
    // is right for hover; focus is an explicit "show me only this", and leaving
    // two thousand ghosts behind would be answering a different question.
    if (state.focusNodeIds && !state.focusNodeIds.has(id)) {
      result.hidden = true;
      return result;
    }

    result.hidden = false;

    const style = nodeStyle(node.type);
    const selected = state.selectedNodeId === id;
    const hovered = state.hoveredNodeId === id;
    const inPath = state.pathNodeIds?.has(id) ?? false;
    const matched = state.matchedNodeIds?.has(id) ?? false;
    const inScope = inDetailScope(node, this.detailLevel, state.priorityNodeTypes);

    let attention = 1;
    if (this.attentionNodes && !this.attentionNodes.has(id)) attention = 0.16;
    if (state.pathNodeIds) attention = Math.min(attention, inPath ? 1 : 0.12);
    if (!inScope) attention = Math.min(attention, 0.3);
    if (selected || hovered || matched) attention = 1;

    const emphasised = selected || hovered || inPath || matched;

    result.size = baseSizeOf(node) * (inScope ? 1 : 0.42) * (selected ? 1.3 : 1);
    result.color = emphasised
      ? brighten(style.color, selected ? 0.35 : 0.18)
      : dim(style.color, 1 - attention);

    // Glow is importance made visible. It is capped well below full opacity so
    // a dense cluster reads as one bright region rather than as a white blob.
    const glow = Math.min(0.55, style.glow * (0.15 + node.metrics.importance * 0.75));
    result.glow = selected ? 0.85 : inPath || matched ? 0.6 : glow * attention;

    // Thickness is a fraction of the node radius, so it had to grow when the
    // nodes shrank: a ring around a six-pixel disc is otherwise a hairline.
    result.ring = selected ? 0.2 : inPath ? 0.15 : state.expandedNodeIds.has(id) ? 0.09 : 0;
    result.ringColor = selected ? ACCENT : inPath ? PATH_ACCENT : '#55637a';
    result.shape = NODE_SHAPES[style.shape];
    result.zIndex = Math.round(node.metrics.importance * 10) + (emphasised ? 20 : 0);

    const decision = state.showLabels
      ? labelFor(node, {
          level: this.detailLevel,
          density: state.labelDensity,
          forced: selected || hovered || inPath || matched,
          priority: state.priorityNodeTypes,
        })
      : { label: null, alpha: 0 };

    result.label = decision.label;
    (result as { labelAlpha?: number }).labelAlpha = decision.alpha * Math.max(attention, 0.55);
    (result as { labelWeight?: number }).labelWeight = emphasised ? 600 : 500;
    result.forceLabel = selected || hovered || inPath;

    return result;
  };

  private readonly reduceEdge = (id: string, data: Attributes): Partial<EdgeDisplayData> => {
    const edge = this.model?.edgesById.get(id);
    const result = { ...data } as EdgeDisplayData;

    if (!edge) return result;

    const state = this.state;
    const style = edgeStyle(edge.type);
    const selected = state.selectedEdgeId === id;
    const inPath = state.pathEdgeIds?.has(id) ?? false;

    let attention = 1;
    if (this.attentionEdges && !this.attentionEdges.has(id)) attention = 0.12;
    if (state.pathNodeIds) attention = Math.min(attention, inPath ? 1 : 0.08);
    if (selected || inPath) attention = 1;

    result.hidden = false;
    // Observation count thickens an edge, so a call made in forty places reads
    // as heavier traffic than one made once.
    const traffic = 1 + Math.min(0.7, Math.log1p(edge.weight) / 5);
    result.size = style.width * traffic * (selected || inPath ? 2 : 1);
    result.color = selected
      ? ACCENT
      : inPath
        ? PATH_ACCENT
        : attention >= 1
          ? style.color
          : dim(style.color, 1 - attention);
    result.type = style.program;
    result.zIndex = selected || inPath ? 10 : style.emphasis === 'strong' ? 2 : 0;

    // Twenty rotated relationship names across an overview is the clutter this
    // whole design exists to avoid, so they wait for a zoom level that asked
    // for detail. A selected or path edge always says what it is.
    const labelled =
      selected ||
      inPath ||
      (state.showEdgeLabels && style.labelled && this.detailLevel !== 'overview');
    result.label = labelled ? edge.type : '';
    result.forceLabel = selected || inPath;

    return result;
  };

  // --- events -------------------------------------------------------------

  private bindEvents(): void {
    this.sigma.on('clickNode', ({ node }) => {
      this.callbacks.onSelectNode(node);
    });
    this.sigma.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
      // Sigma's own double-click zooms; expansion is the more useful meaning
      // here and the two together would be disorienting.
      preventSigmaDefault();
      this.callbacks.onExpandNode(node);
    });
    this.sigma.on('clickEdge', ({ edge }) => {
      this.callbacks.onSelectEdge(edge);
    });
    this.sigma.on('enterNode', ({ node }) => {
      this.callbacks.onHoverNode(node);
    });
    this.sigma.on('leaveNode', () => {
      this.callbacks.onHoverNode(null);
    });
    this.sigma.on('clickStage', () => {
      this.callbacks.onClearSelection();
    });

    // The label renderer avoids overlapping what it has already drawn, which
    // means it needs to know when a frame begins. This is that point.
    this.sigma.on('beforeRender', () => {
      labelPlacement.beginFrame();
    });

    this.sigma.getCamera().on('updated', () => {
      if (this.cameraFrame !== null) return;

      this.cameraFrame = requestAnimationFrame(() => {
        this.cameraFrame = null;

        const ratio = this.sigma.getCamera().ratio;
        const level = detailLevelFor(ratio);

        if (level !== this.detailLevel) {
          this.detailLevel = level;
          // A tier change resizes nodes, so the label grid has to be rebuilt.
          this.scheduleRefresh(false);
        }

        this.callbacks.onCameraChange({ ratio, detailLevel: level });
      });
    });
  }

  // --- camera -------------------------------------------------------------

  fit(animated = true): void {
    const camera = this.sigma.getCamera();
    if (animated) void camera.animatedReset({ duration: 380 });
    else camera.setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  }

  resetView(): void {
    this.fit(true);
  }

  zoomBy(factor: number): void {
    const camera = this.sigma.getCamera();
    void camera.animate({ ratio: camera.getBoundedRatio(camera.ratio * factor) }, { duration: 180 });
  }

  /** Centres a node and zooms in far enough to read its neighbourhood. */
  focusNode(nodeId: string, options: { ratio?: number } = {}): void {
    const data = this.sigma.getNodeDisplayData(nodeId);
    if (!data) return;

    const camera = this.sigma.getCamera();
    void camera.animate(
      { x: data.x, y: data.y, ratio: camera.getBoundedRatio(options.ratio ?? 0.32) },
      { duration: 420 },
    );
  }

  /** Frames a set of nodes: the path finder and focus mode both use it. */
  frameNodes(nodeIds: readonly string[]): void {
    if (nodeIds.length === 0) return;
    if (nodeIds.length === 1) {
      this.focusNode(nodeIds[0] as string, { ratio: 0.4 });
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const id of nodeIds) {
      const data = this.sigma.getNodeDisplayData(id);
      if (!data) continue;
      minX = Math.min(minX, data.x);
      minY = Math.min(minY, data.y);
      maxX = Math.max(maxX, data.x);
      maxY = Math.max(maxY, data.y);
    }

    if (!Number.isFinite(minX)) return;

    const camera = this.sigma.getCamera();
    const { width, height } = this.sigma.getDimensions();
    const spanX = Math.max(maxX - minX, 0.02);
    const spanY = Math.max(maxY - minY, 0.02);

    // The framed graph is normalised to roughly one unit across, so the ratio
    // that fits a span is the span itself, plus room to breathe.
    const ratio = Math.max(spanX * (height / width), spanY) * 1.45;

    void camera.animate(
      {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        ratio: camera.getBoundedRatio(Math.max(ratio, 0.08)),
      },
      { duration: 420 },
    );
  }

  // --- readouts -----------------------------------------------------------

  getDetailLevel(): DetailLevel {
    return this.detailLevel;
  }

  /**
   * Node positions in framed-graph space, for the minimap.
   *
   * Framed space is what the camera works in, so the minimap can draw the
   * viewport rectangle in the same coordinates without a second projection.
   */
  snapshotNodes(): Array<{ id: string; x: number; y: number; color: string; size: number }> {
    const snapshot: Array<{ id: string; x: number; y: number; color: string; size: number }> = [];

    this.graph.forEachNode((node) => {
      const data = this.sigma.getNodeDisplayData(node);
      if (!data || data.hidden) return;
      snapshot.push({ id: node, x: data.x, y: data.y, color: data.color, size: data.size });
    });

    return snapshot;
  }

  viewportRect(): { x1: number; y1: number; x2: number; y2: number } {
    const { width, height } = this.sigma.getDimensions();
    const topLeft = this.sigma.viewportToFramedGraph({ x: 0, y: 0 });
    const bottomRight = this.sigma.viewportToFramedGraph({ x: width, y: height });

    return { x1: topLeft.x, y1: topLeft.y, x2: bottomRight.x, y2: bottomRight.y };
  }

  nodeViewportPosition(nodeId: string): { x: number; y: number } | null {
    const data = this.sigma.getNodeDisplayData(nodeId);
    if (!data || data.hidden) return null;
    return this.sigma.framedGraphToViewport(data);
  }

  resize(): void {
    this.sigma.resize();
  }

  kill(): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    if (this.refreshFrame !== null) cancelAnimationFrame(this.refreshFrame);
    if (this.cameraFrame !== null) cancelAnimationFrame(this.cameraFrame);
    this.particles.kill();
    this.sigma.kill();
    this.graph.clear();
  }
}

/**
 * How big a node is before anything else happens to it.
 *
 * The type sets the floor — a database is a bigger object than a parameter
 * whatever the topology says — and importance scales it from there, which is
 * what makes hubs read as hubs at a glance. The band is deliberately narrow:
 * glow already carries importance, and doubling that with size too is what
 * turns a hub into a blob.
 */
function baseSizeOf(node: GraphNode): number {
  return nodeStyle(node.type).size * (0.8 + node.metrics.importance * 0.85);
}

export function edgeTypeOf(edge: GraphEdge): string {
  return edgeStyle(edge.type).program;
}

export { CANVAS_INK };
