import type { CodeNodeType } from '../types/graph.js';

/**
 * Node types grouped into the four families the UI colours by.
 *
 * Ten node types cannot be given ten distinguishable hues: on a dark surface no
 * set of more than four categorical hues clears all-pairs colour-vision
 * separation, and past three the margins are thin. So hue carries the *family*
 * and shape carries the member within it — composite encoding — with the label
 * always present as the exact identity.
 *
 * The same grouping drives the dashboard's composition bar, so a colour means
 * the same thing in both places.
 */
export const NODE_FAMILIES = ['types', 'callables', 'data', 'structure'] as const;

export type NodeFamily = (typeof NODE_FAMILIES)[number];

export const NODE_FAMILY_BY_TYPE: Record<CodeNodeType, NodeFamily> = {
  class: 'types',
  interface: 'types',
  type: 'types',

  function: 'callables',
  method: 'callables',

  variable: 'data',

  repository: 'structure',
  directory: 'structure',
  file: 'structure',
  module: 'structure',
};

export const NODE_FAMILY_LABELS: Record<NodeFamily, string> = {
  types: 'Types',
  callables: 'Callables',
  data: 'Data',
  structure: 'Structure',
};

export function familyOf(type: CodeNodeType): NodeFamily {
  return NODE_FAMILY_BY_TYPE[type];
}
