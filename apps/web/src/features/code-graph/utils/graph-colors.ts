import { NODE_FAMILY_BY_TYPE } from '@ckg/shared';
import type { CodeNodeType, NodeFamily } from '../../../types/index.js';

/**
 * The semantic colour system, in one place.
 *
 * Colour communicates *what a node is*, never which one it happens to be. The
 * assignment below is not a fresh choice: it is the palette this project
 * already validated against its dark surfaces, kept because throwing away a
 * verified result to get more hues would trade correctness for novelty.
 *
 * ## Why hue encodes the family, not the node type
 *
 * There are twenty-one node types. On a near-black surface no set of more than
 * four categorical hues clears all-pairs colour-vision separation — enumerated,
 * not guessed: of the 70 four-hue subsets of a validated eight-hue palette only
 * two pass, and no five- or six-hue subset passes at all.
 *
 * So the encoding is composite: **hue = family, shape = member, size and glow =
 * importance, label = exact identity**. Four families carry the code hues that
 * were validated against the canvas surface; the two architectural families are
 * additions, and for them shape and badge — not hue — are the primary channel.
 *
 * ## Why role does not get its own hue
 *
 * A controller and a service are both classes. Giving `role` a hue would mean
 * two things competing for the same channel, so a role is carried by the badge
 * in the inspector, by the search result and by a ring on the canvas instead.
 */

/** The canvas void. Everything dims *towards* this rather than to alpha. */
export const CANVAS_INK = '#04070e';

/** Selection and focus, deliberately outside the data palette. */
export const ACCENT = '#7cc4ff';
export const ACCENT_WARM = '#ffb968';
/** The path finder's highlight, distinct from a plain selection. */
export const PATH_ACCENT = '#5ce7c0';

export const FAMILY_COLORS: Record<NodeFamily, string> = {
  types: '#3987e5', // blue
  callables: '#d95926', // orange
  data: '#199e70', // aqua
  structure: '#7c8699', // neutral — context, not identity
  services: '#9085e9', // violet — the system's own surfaces
  resources: '#c2548f', // magenta — what it stores and talks to
};

/**
 * Structure is a hierarchy, so it gets a sequential ramp instead of a hue:
 * lighter is nearer the root. Monotonic in lightness, which is the check that
 * applies to a sequential scale.
 */
const STRUCTURE_RAMP: Partial<Record<CodeNodeType, string>> = {
  repository: '#e2e8f0',
  directory: '#a9b4c6',
  file: '#7c8699',
  module: '#5b6475',
};

export function nodeColor(type: CodeNodeType): string {
  return STRUCTURE_RAMP[type] ?? FAMILY_COLORS[NODE_FAMILY_BY_TYPE[type]];
}

export function familyColor(family: NodeFamily): string {
  return FAMILY_COLORS[family];
}

// --- colour maths ---------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const CACHE = new Map<string, Rgb>();

export function parseHex(hex: string): Rgb {
  const cached = CACHE.get(hex);
  if (cached) return cached;

  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;

  const rgb: Rgb = {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };

  CACHE.set(hex, rgb);
  return rgb;
}

function channel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Linear blend: `amount` of 0 returns `from`, 1 returns `to`. */
export function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const t = Math.max(0, Math.min(1, amount));

  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

/**
 * Fades a colour towards the canvas void.
 *
 * Dimming is done by blending rather than by lowering alpha because Sigma
 * renders with premultiplied blending and the graph is drawn over a single
 * known background: blending gives the same result, keeps every colour opaque,
 * and means a dimmed node cannot be brightened by whatever is drawn under it.
 */
export function dim(color: string, amount: number): string {
  return mix(color, CANVAS_INK, amount);
}

/** Lifts a colour towards white, for the selected node's core. */
export function brighten(color: string, amount: number): string {
  return mix(color, '#ffffff', amount);
}

export function rgba(color: string, alpha: number): string {
  const { r, g, b } = parseHex(color);
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(alpha)})`;
}
