import type { CodeNodeType } from '../types/graph.js';

/**
 * Node types grouped into the families the UI colours by, and the two
 * categories those families belong to.
 *
 * ## Why hue encodes the family, not the node type
 *
 * There are twenty-one node types. On a dark surface no set of more than four
 * categorical hues clears all-pairs colour-vision separation — enumerated, not
 * guessed: of the 70 four-hue subsets of a validated eight-hue palette only two
 * pass, and no five- or six-hue subset passes at all. Twenty-one
 * distinguishable hues does not exist.
 *
 * So the encoding is composite: **hue = family, shape = member, badge/label =
 * exact identity**. Four families carry the code hues that were validated
 * against the canvas surfaces; the two architectural families are additions,
 * and for them shape and badge — not hue — are the primary channel. That is
 * why every architectural node type has its own shape and why the inspector,
 * the legend and the search results all print the type name.
 *
 * The same grouping drives the dashboard's composition bar, so a colour means
 * the same thing in both places.
 */
export const NODE_FAMILIES = [
  'types',
  'callables',
  'data',
  'structure',
  'services',
  'resources',
] as const;

export type NodeFamily = (typeof NODE_FAMILIES)[number];

/** Families split into what the code *is* and how the system is *composed*. */
export const NODE_CATEGORIES = ['code', 'architecture'] as const;

export type NodeCategory = (typeof NODE_CATEGORIES)[number];

export const NODE_FAMILY_BY_TYPE: Record<CodeNodeType, NodeFamily> = {
  class: 'types',
  interface: 'types',
  type: 'types',
  enum: 'types',

  function: 'callables',
  method: 'callables',

  variable: 'data',
  property: 'data',
  parameter: 'data',

  repository: 'structure',
  directory: 'structure',
  file: 'structure',
  module: 'structure',

  api: 'services',
  service: 'services',
  external_service: 'services',

  database: 'resources',
  table: 'resources',
  queue: 'resources',
  event: 'resources',
  config: 'resources',
};

export const NODE_FAMILY_LABELS: Record<NodeFamily, string> = {
  types: 'Types',
  callables: 'Callables',
  data: 'Data',
  structure: 'Structure',
  services: 'Services',
  resources: 'Resources',
};

export const NODE_CATEGORY_BY_FAMILY: Record<NodeFamily, NodeCategory> = {
  types: 'code',
  callables: 'code',
  data: 'code',
  structure: 'code',
  services: 'architecture',
  resources: 'architecture',
};

export const NODE_CATEGORY_LABELS: Record<NodeCategory, string> = {
  code: 'Code',
  architecture: 'Architecture',
};

/** Families in each category, in the fixed order the legend renders them. */
export const FAMILIES_BY_CATEGORY: Record<NodeCategory, NodeFamily[]> = {
  code: ['types', 'callables', 'data', 'structure'],
  architecture: ['services', 'resources'],
};

export function familyOf(type: CodeNodeType): NodeFamily {
  return NODE_FAMILY_BY_TYPE[type];
}

export function categoryOf(type: CodeNodeType): NodeCategory {
  return NODE_CATEGORY_BY_FAMILY[NODE_FAMILY_BY_TYPE[type]];
}

/** Human-readable label for a node type, for badges and legends. */
export const NODE_TYPE_LABELS: Record<CodeNodeType, string> = {
  repository: 'Repository',
  directory: 'Directory',
  file: 'File',
  module: 'Module',
  class: 'Class',
  interface: 'Interface',
  function: 'Function',
  method: 'Method',
  variable: 'Variable',
  type: 'Type',
  enum: 'Enum',
  property: 'Property',
  parameter: 'Parameter',
  api: 'API',
  service: 'Service',
  database: 'Database',
  table: 'Table',
  queue: 'Queue',
  event: 'Event',
  external_service: 'External service',
  config: 'Config',
};
