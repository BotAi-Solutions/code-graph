import type { Settings } from 'sigma/settings';
import type { NodeDisplayData, PartialButFor } from 'sigma/types';
import type { CodeNodeType } from '../../../types/index.js';
import type { GraphNode } from '../model/graph-types.js';
import { nodeStyle } from '../model/node-types.js';
import { CANVAS_INK, brighten, rgba } from '../utils/graph-colors.js';

/**
 * Semantic zoom, and the labels that follow from it.
 *
 * A code graph has one failure mode above all others: every node labelled, all
 * the time, until the labels are the picture and the graph is the background.
 * The rule here is that **zoom selects a level of description**, not a
 * magnification — the far view is about architecture, the near view is about
 * symbols, and a node earns a label by being worth reading at the level you are
 * currently at.
 *
 * Two mechanisms, deliberately separate:
 *
 * - **Detail level** decides which node *types* are subjects at this zoom.
 *   Below the current level a node is not hidden — hiding would tear holes in
 *   the shape of the graph — it is dimmed to a speck, so a thousand methods
 *   read as the texture of a module rather than as a thousand things.
 * - **Label score** decides which of the subjects get names, and fades them in
 *   rather than snapping, so crossing a threshold is not a flash of text.
 *
 * Collision avoidance happens twice. Sigma's grid keeps the largest node per
 * cell, and since size already encodes importance the node that survives a
 * contested cell is the one that deserved the label anyway. The drawing pass
 * then resolves what the grid cannot see — how wide the text actually turned
 * out — by tracking the rectangles it has used; see `LabelPlacement` below.
 */

export type DetailLevel = 'overview' | 'structure' | 'detail';

export const DETAIL_LEVELS: readonly DetailLevel[] = ['overview', 'structure', 'detail'];

/**
 * Camera ratio boundaries. Sigma's ratio shrinks as you zoom in, so the
 * comparisons read backwards from what the names suggest.
 */
const STRUCTURE_RATIO = 1.15;
const DETAIL_RATIO = 0.45;

export function detailLevelFor(cameraRatio: number): DetailLevel {
  if (cameraRatio > STRUCTURE_RATIO) return 'overview';
  if (cameraRatio > DETAIL_RATIO) return 'structure';
  return 'detail';
}

export function detailIndexOf(level: DetailLevel): 0 | 1 | 2 {
  return level === 'overview' ? 0 : level === 'structure' ? 1 : 2;
}

/**
 * How much label a level can afford.
 *
 * The far view is the strictest because it is the one that has to stay
 * readable without any help from the user; the near view lets Sigma's
 * collision grid do the work, because by then the user has chosen where to
 * look and wants to read what is there.
 */
const LABEL_THRESHOLD: Record<DetailLevel, number> = {
  overview: 0.62,
  structure: 0.4,
  detail: 0.1,
};

/** Where the fade from invisible to fully drawn happens, in score units. */
const FADE_BAND = 0.14;

/**
 * Longest label drawn on the canvas.
 *
 * `PATCH /users/:id/verify` is 23 characters and, drawn in full next to four
 * sibling routes, covers all of them. The tooltip and the inspector carry the
 * whole name; the canvas only has to make the node findable.
 */
const MAX_LABEL = 22;

function clamp(label: string): string {
  return label.length <= MAX_LABEL ? label : `${label.slice(0, MAX_LABEL - 1)}…`;
}

/**
 * Node types the active mode is *about*.
 *
 * These come from the server's projection definitions, which already say which
 * types each mode ranks first. Reusing them here is what stops the Call graph
 * from dimming methods and the Files view from hiding filenames: the type
 * table below is a global ranking, and a mode is a statement that, for now,
 * the global ranking is not the one that matters.
 */
export type PriorityTypes = ReadonlySet<CodeNodeType>;

export const NO_PRIORITY: PriorityTypes = new Set<CodeNodeType>();

/**
 * How much a node deserves its name drawn.
 *
 * Five terms, because no one of them is enough. Type priority says a `service`
 * is worth naming even when it is quiet. Importance says a method with forty
 * callers is worth naming even though methods generally are not. The role
 * bonus matters more than it looks: `UserService` is a `class` as far as the
 * compiler is concerned, and without it the most architecturally significant
 * nodes in a TypeScript repository would score as ordinary classes and go
 * unnamed at exactly the zoom where they are the subject. Entry points get a
 * smaller nudge for the same reason, and the mode's own subject gets the
 * largest one.
 */
export function labelScore(node: GraphNode, priority: PriorityTypes = NO_PRIORITY): number {
  return (
    nodeStyle(node.type).labelPriority * 0.5 +
    node.metrics.importance * 0.4 +
    (node.role !== null ? 0.12 : 0) +
    (node.entryPoint ? 0.08 : 0) +
    (priority.has(node.type) ? 0.15 : 0)
  );
}

export interface LabelDecision {
  /** Null means Sigma draws nothing for this node. */
  label: string | null;
  /** 0–1, applied by the label renderer. */
  alpha: number;
}

export interface LabelContext {
  level: DetailLevel;
  /** From the graph mode: a sparse view can afford more names. */
  density: number;
  /** Always labelled, whatever the zoom: the user asked about these. */
  forced: boolean;
  /** What the active mode is about. */
  priority: PriorityTypes;
}

export function labelFor(node: GraphNode, context: LabelContext): LabelDecision {
  if (context.forced) return { label: clamp(node.label), alpha: 1 };

  const threshold = LABEL_THRESHOLD[context.level] / Math.max(0.2, context.density);
  const score = labelScore(node, context.priority);

  if (score < threshold) return { label: null, alpha: 0 };

  const alpha = Math.min(1, 0.35 + ((score - threshold) / FADE_BAND) * 0.65);
  return { label: clamp(node.label), alpha };
}

/**
 * Whether a node is a subject at this zoom, or texture.
 *
 * Two things override the tier. Importance, because a method that half the
 * repository calls is architecture whatever the type table says. And the
 * mode's own priority types, because a call graph that renders its methods as
 * specks has answered a question nobody asked.
 */
export function inDetailScope(
  node: GraphNode,
  level: DetailLevel,
  priority: PriorityTypes = NO_PRIORITY,
): boolean {
  if (priority.has(node.type)) return true;
  if (nodeStyle(node.type).detailTier <= detailIndexOf(level)) return true;
  return node.metrics.importance >= 0.62;
}

// --- drawing --------------------------------------------------------------

/** Extra fields the engine writes for the label renderer to read. */
interface LabelData {
  labelAlpha?: number;
  labelWeight?: number;
}

const PLATE_PADDING_X = 5;
const PLATE_PADDING_Y = 3;
/** Breathing room between two labels before they count as colliding. */
const LABEL_GAP = 2;

interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Where labels have already been drawn this frame.
 *
 * Sigma's own collision avoidance works on *nodes*: it keeps the biggest node
 * per grid cell and lets that one have a label. That is the right first pass,
 * but it knows nothing about how wide the text turned out — two nodes in
 * different cells can still produce labels that overlap, which is exactly what
 * a tight cluster of API routes does.
 *
 * So the drawing pass keeps the rectangles it has used. A label that would
 * land on one already taken is moved to the other side of its node, and if
 * that is taken too it is dropped: one unreadable pair is worse than one
 * missing name, and the name is still a hover away.
 *
 * Reset from the engine on Sigma's `beforeRender`, which is the only point at
 * which a frame is known to be starting.
 */
class LabelPlacement {
  private taken: Rect[] = [];

  beginFrame(): void {
    this.taken = [];
  }

  claim(rect: Rect): boolean {
    for (const other of this.taken) {
      if (
        rect.x1 < other.x2 + LABEL_GAP &&
        rect.x2 + LABEL_GAP > other.x1 &&
        rect.y1 < other.y2 + LABEL_GAP &&
        rect.y2 + LABEL_GAP > other.y1
      ) {
        return false;
      }
    }

    this.taken.push(rect);
    return true;
  }

  /** Takes the space whether or not it was free: for hover and selection. */
  force(rect: Rect): void {
    this.taken.push(rect);
  }
}

export const labelPlacement = new LabelPlacement();

/**
 * Draws one node label.
 *
 * Replaces Sigma's default because the default is a plain string on the canvas,
 * which on a dark graph with edges crossing behind it is unreadable about a
 * third of the time. A plate the colour of the void, and text tinted towards
 * the node's own hue, keeps the label attached to its node without shouting.
 */
export function drawCodeNodeLabel(
  context: CanvasRenderingContext2D,
  data: PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'> & LabelData,
  settings: Settings,
): void {
  if (!data.label) return;

  const alpha = data.labelAlpha ?? 1;
  if (alpha <= 0.02) return;

  const weight = data.labelWeight ?? 400;
  const size = settings.labelSize;
  context.font = `${String(weight)} ${String(size)}px ${settings.labelFont}`;

  const width = context.measureText(data.label).width;
  const y = data.y + size / 3;

  const plate = (x: number): Rect => ({
    x1: x - PLATE_PADDING_X,
    y1: y - size + PLATE_PADDING_Y - 1,
    x2: x + width + PLATE_PADDING_X,
    y2: y + PLATE_PADDING_Y + 1,
  });

  const right = data.x + data.size + 7;
  const left = data.x - data.size - 7 - width;

  let x: number;

  if (data.forceLabel === true) {
    // The user pointed at this one; it is drawn wherever it belongs and the
    // labels around it give way.
    x = right;
    labelPlacement.force(plate(x));
  } else if (labelPlacement.claim(plate(right))) {
    x = right;
  } else if (labelPlacement.claim(plate(left))) {
    x = left;
  } else {
    return;
  }

  const rect = plate(x);

  context.fillStyle = rgba(CANVAS_INK, 0.72 * alpha);
  context.beginPath();
  context.roundRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1, 3);
  context.fill();

  // Tinting the text towards the node's hue is what keeps a label bound to its
  // node in a dense cluster, where proximity alone is ambiguous.
  context.fillStyle = rgba(brighten(data.color, 0.62), alpha);
  context.fillText(data.label, x, y);
}

/**
 * Draws the label of the node under the cursor.
 *
 * Deliberately close to the normal label: the tooltip beside the cursor already
 * carries the detail, so a second, louder card here would be the third thing
 * competing for the same attention.
 */
export function drawCodeNodeHover(
  context: CanvasRenderingContext2D,
  data: PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'> & LabelData,
  settings: Settings,
): void {
  // The hover layer is repainted on its own frames, without the label pass, so
  // it never shares a placement budget with anything.
  labelPlacement.beginFrame();
  drawCodeNodeLabel(
    context,
    { ...data, labelAlpha: 1, labelWeight: 600, forceLabel: true },
    settings,
  );
}
