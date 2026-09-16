import type Sigma from 'sigma';
import type { CodeGraphModel } from '../model/graph-types.js';
import { edgeStyle } from '../model/edge-types.js';
import { brighten, rgba } from '../utils/graph-colors.js';

/**
 * Flow along the edges that carry it.
 *
 * The point is not decoration. A dependency graph draws `A → B` identically
 * whether B is called once at boot or on every request, and an arrowhead two
 * pixels wide is easy to miss entirely; a moving particle says *which way the
 * work goes* at a glance, from across the viewport, without a label.
 *
 * Which is why it is deliberately rationed:
 *
 * - only relationships whose direction a reader actually follows (a call, a
 *   route, a write) — never containment, which never surprised anyone;
 * - only the most important edges, capped at a fixed budget, so the cost is
 *   flat no matter how large the graph is;
 * - off entirely under `prefers-reduced-motion`, when the tab is hidden, when
 *   the graph is too big for the budget to mean anything, or when the user
 *   turns it off.
 *
 * It draws to its own 2D layer between Sigma's edges and nodes, so nothing here
 * touches the WebGL pipeline or React: the animation loop reads Sigma's camera
 * and writes pixels, and stops when there is nothing to animate.
 */

export interface ParticleOptions {
  /** Most edges to animate at once, whatever the graph size. */
  budget?: number;
  /** Above this many nodes, animation is skipped entirely. */
  nodeCeiling?: number;
}

const DEFAULT_BUDGET = 140;
const DEFAULT_NODE_CEILING = 6000;

/** Particles per edge, and how far apart along it they sit. */
const PER_EDGE = 2;
/** Travel time from source to target, in milliseconds. */
const TRANSIT_MS = 2600;

interface FlowEdge {
  source: string;
  target: string;
  color: string;
  /** 0–1: how bright and how big the particles are. */
  intensity: number;
}

export class ParticleEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly reducedMotion: MediaQueryList | null;

  private edges: FlowEdge[] = [];
  private frame: number | null = null;
  private enabled = true;
  private running = false;
  private pixelRatio = 1;

  constructor(
    private readonly sigma: Sigma,
    private readonly options: ParticleOptions = {},
  ) {
    this.canvas = sigma.createCanvas('flow', { beforeLayer: 'nodes' });
    this.canvas.style.pointerEvents = 'none';
    this.context = this.canvas.getContext('2d');

    this.reducedMotion =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    this.reducedMotion?.addEventListener('change', this.onMotionPreferenceChange);

    document.addEventListener('visibilitychange', this.onVisibilityChange);
    sigma.on('resize', this.resize);
    this.resize();
  }

  /**
   * Chooses what to animate.
   *
   * Ranked by the importance of the two endpoints and the weight of the
   * relationship, so the budget is spent on the flows that describe the system
   * — a route reaching its controller — rather than on whichever edges happen
   * to be first in the array.
   */
  setGraph(model: CodeGraphModel, options: { animate: boolean }): void {
    this.enabled = options.animate;

    const ceiling = this.options.nodeCeiling ?? DEFAULT_NODE_CEILING;

    if (!options.animate || model.nodes.length > ceiling) {
      this.edges = [];
      this.stop();
      this.clear();
      return;
    }

    const candidates: Array<FlowEdge & { rank: number }> = [];

    for (const edge of model.edges) {
      const style = edgeStyle(edge.type);
      if (!style.flow) continue;

      const from = model.nodesById.get(edge.source);
      const to = model.nodesById.get(edge.target);
      if (!from || !to) continue;

      const rank =
        (from.metrics.importance + to.metrics.importance) / 2 +
        (style.emphasis === 'strong' ? 0.2 : 0) +
        Math.min(0.15, Math.log1p(edge.weight) / 20);

      candidates.push({
        source: edge.source,
        target: edge.target,
        color: brighten(style.color, 0.45),
        intensity: Math.min(1, 0.35 + rank),
        rank,
      });
    }

    candidates.sort((a, b) => b.rank - a.rank);
    this.edges = candidates.slice(0, this.options.budget ?? DEFAULT_BUDGET);

    if (this.edges.length > 0) this.start();
    else {
      this.stop();
      this.clear();
    }
  }

  private readonly onMotionPreferenceChange = (): void => {
    if (this.reducedMotion?.matches) {
      this.stop();
      this.clear();
    } else if (this.enabled && this.edges.length > 0) {
      this.start();
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.stop();
    else if (this.enabled && this.edges.length > 0) this.start();
  };

  private readonly resize = (): void => {
    const { width, height } = this.sigma.getDimensions();
    this.pixelRatio = window.devicePixelRatio || 1;

    this.canvas.width = Math.max(1, Math.round(width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(height * this.pixelRatio));
    this.canvas.style.width = `${String(width)}px`;
    this.canvas.style.height = `${String(height)}px`;
  };

  private start(): void {
    if (this.running || this.reducedMotion?.matches || document.hidden) return;
    this.running = true;
    this.frame = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    this.running = false;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private clear(): void {
    this.context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private readonly tick = (time: number): void => {
    if (!this.running) return;

    const context = this.context;
    if (context) {
      const ratio = this.pixelRatio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, this.canvas.width / ratio, this.canvas.height / ratio);

      // Additive, so particles read as light travelling over the edge rather
      // than as beads drawn on top of it.
      context.globalCompositeOperation = 'lighter';

      const phase = (time % TRANSIT_MS) / TRANSIT_MS;

      for (const edge of this.edges) {
        const source = this.sigma.getNodeDisplayData(edge.source);
        const target = this.sigma.getNodeDisplayData(edge.target);
        if (!source || !target || source.hidden || target.hidden) continue;

        const from = this.sigma.framedGraphToViewport(source);
        const to = this.sigma.framedGraphToViewport(target);

        for (let index = 0; index < PER_EDGE; index += 1) {
          const progress = (phase + index / PER_EDGE) % 1;
          const x = from.x + (to.x - from.x) * progress;
          const y = from.y + (to.y - from.y) * progress;

          // Fading in and out at the ends stops particles from appearing to
          // spawn inside a node and die inside another.
          const fade = Math.sin(progress * Math.PI);
          const alpha = fade * fade * edge.intensity * 0.7;
          if (alpha < 0.02) continue;

          const radius = 0.8 + edge.intensity * 0.9;

          context.fillStyle = rgba(edge.color, alpha);
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.fill();
        }
      }

      context.globalCompositeOperation = 'source-over';
    }

    this.frame = requestAnimationFrame(this.tick);
  };

  kill(): void {
    this.stop();
    this.reducedMotion?.removeEventListener('change', this.onMotionPreferenceChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.sigma.off('resize', this.resize);
    this.canvas.remove();
  }
}
