import { NODE_FAMILY_BY_TYPE, NODE_FAMILY_LABELS, NODE_FAMILIES } from '@ckg/shared';
import type { CodeNodeType, CodeRelationship, NodeFamily } from '../../types/index.js';

/**
 * The visual language, in one place, so a colour means the same thing on the
 * canvas, in the legend and on the dashboard.
 *
 * ## Why hue encodes the *family*, not the node type
 *
 * There are ten node types. On this dark surface no set of more than four
 * categorical hues clears all-pairs colour-vision separation — enumerated, not
 * guessed: of the 70 four-hue subsets of a validated eight-hue palette only two
 * pass, and no five- or six-hue subset passes at all. Ten distinguishable hues
 * is not available.
 *
 * So the canvas uses composite encoding: **hue = family, shape = member, label =
 * exact identity**. Three identity hues (blue / orange / aqua) carry the code
 * families and clear all-pairs separation with room to spare; structure is
 * scaffolding rather than subject, so it takes a neutral lightness ramp where
 * lighter means nearer the repository root.
 *
 * Validated against surface #060910 (canvas) and #0f1622 (cards):
 *   worst all-pairs CVD ΔE 9.4, normal-vision ΔE 20.9, all ≥ 3:1 contrast.
 */

export const FAMILY_COLORS: Record<NodeFamily, string> = {
  types: '#3987e5', // blue
  callables: '#d95926', // orange
  data: '#199e70', // aqua
  structure: '#7c8699', // neutral — context, not identity
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

/** Cytoscape shape per node type — the second channel of the encoding. */
export const NODE_SHAPES: Record<CodeNodeType, string> = {
  repository: 'round-rectangle',
  directory: 'round-rectangle',
  file: 'round-rectangle',
  module: 'round-rectangle',

  class: 'ellipse',
  interface: 'round-hexagon',
  type: 'round-diamond',

  function: 'ellipse',
  method: 'ellipse',

  variable: 'round-diamond',
};

/** Diameter per node type. Size ranks importance within a family. */
export const NODE_SIZES: Record<CodeNodeType, number> = {
  repository: 38,
  directory: 26,
  file: 24,
  module: 22,

  class: 32,
  interface: 30,
  type: 22,

  function: 26,
  method: 22,

  variable: 16,
};

/**
 * Relationship colours. These never collide with the node families because
 * edges are thin lines read against the background, and each is labelled on
 * selection.
 */
export const RELATIONSHIP_COLORS: Record<CodeRelationship, string> = {
  CONTAINS: '#3f4a5c',
  IMPORTS: '#5b6475',
  CALLS: '#d95926',
  REFERENCES: '#3987e5',
  IMPLEMENTS: '#199e70',
  EXTENDS: '#9085e9',
};

/** Drawn dashed because they describe structure rather than behaviour. */
export const STRUCTURAL_RELATIONSHIPS: ReadonlySet<CodeRelationship> = new Set([
  'CONTAINS',
  'IMPORTS',
]);

export function relationshipColor(relationship: CodeRelationship): string {
  return RELATIONSHIP_COLORS[relationship] ?? '#3f4a5c';
}

/** Node types grouped by family, in the fixed order the legend and bar use. */
export const TYPES_BY_FAMILY: Record<NodeFamily, CodeNodeType[]> = {
  types: ['class', 'interface', 'type'],
  callables: ['function', 'method'],
  data: ['variable'],
  structure: ['repository', 'directory', 'file', 'module'],
};

export { NODE_FAMILIES, NODE_FAMILY_LABELS };
