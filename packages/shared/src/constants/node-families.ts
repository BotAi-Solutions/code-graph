import type { CodeNodeType } from '../types/graph.js';

/**
 * Node types grouped into the families the UI colours by, and the two
 * categories those families belong to.
 *
 * ## Why hue encodes the family, not the node type
 *
 * There are twenty-eight node types. On a dark surface no set of more than four
 * categorical hues clears all-pairs colour-vision separation — enumerated, not
 * guessed: of the 70 four-hue subsets of a validated eight-hue palette only two
 * pass, and no five- or six-hue subset passes at all. Twenty-eight
 * distinguishable hues does not exist.
 *
 * So the encoding is composite: **hue = family, shape = member, badge/label =
 * exact identity**. Four families carry the code hues that were validated
 * against the canvas surfaces; the architectural and knowledge families are
 * additions, and for them shape and badge — not hue — are the primary channel.
 * That is why every non-code node type has a silhouette no code type uses, and
 * why the inspector, the legend and the search results all print the type
 * name.
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
  'documentation',
  'configuration',
] as const;

export type NodeFamily = (typeof NODE_FAMILIES)[number];

/**
 * Families split three ways: what the code *is*, how the system is *composed*,
 * and what the repository *says about itself*.
 *
 * The third category is the one the repository knowledge graph added. It is
 * kept separate rather than folded into `architecture` because its evidence is
 * different in kind — prose and declarations rather than syntax — and because
 * the default views need to be able to leave it out without also dropping the
 * architecture.
 */
export const NODE_CATEGORIES = ['code', 'architecture', 'knowledge'] as const;

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
  api_spec: 'services',
  api_endpoint: 'services',

  database: 'resources',
  table: 'resources',
  column: 'resources',
  queue: 'resources',
  event: 'resources',
  container: 'resources',

  document: 'documentation',
  document_section: 'documentation',

  config: 'configuration',
  config_property: 'configuration',
};

export const NODE_FAMILY_LABELS: Record<NodeFamily, string> = {
  types: 'Types',
  callables: 'Callables',
  data: 'Data',
  structure: 'Structure',
  services: 'Services',
  resources: 'Resources',
  documentation: 'Documentation',
  configuration: 'Configuration',
};

export const NODE_CATEGORY_BY_FAMILY: Record<NodeFamily, NodeCategory> = {
  types: 'code',
  callables: 'code',
  data: 'code',
  structure: 'code',
  services: 'architecture',
  resources: 'architecture',
  documentation: 'knowledge',
  configuration: 'knowledge',
};

export const NODE_CATEGORY_LABELS: Record<NodeCategory, string> = {
  code: 'Code',
  architecture: 'Architecture',
  knowledge: 'Repository knowledge',
};

/** Families in each category, in the fixed order the legend renders them. */
export const FAMILIES_BY_CATEGORY: Record<NodeCategory, NodeFamily[]> = {
  code: ['types', 'callables', 'data', 'structure'],
  architecture: ['services', 'resources'],
  knowledge: ['documentation', 'configuration'],
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
  document: 'Document',
  document_section: 'Section',
  config_property: 'Config property',
  api_spec: 'API spec',
  api_endpoint: 'Endpoint',
  column: 'Column',
  container: 'Container',
};

/** Node types belonging to a family, in the order `CODE_NODE_TYPES` declares. */
export function nodeTypesForFamily(family: NodeFamily): CodeNodeType[] {
  return (Object.keys(NODE_FAMILY_BY_TYPE) as CodeNodeType[]).filter(
    (type) => NODE_FAMILY_BY_TYPE[type] === family,
  );
}

/**
 * Node types belonging to any of these categories.
 *
 * The bridge between the coarse question a person asks — "only documentation"
 * — and the exact filter the store answers. Derived rather than listed, so a
 * new node type joins its category the moment it is given a family.
 */
export function nodeTypesForCategories(
  categories: readonly NodeCategory[],
): CodeNodeType[] {
  const wanted = new Set(categories);

  return (Object.keys(NODE_FAMILY_BY_TYPE) as CodeNodeType[]).filter((type) =>
    wanted.has(NODE_CATEGORY_BY_FAMILY[NODE_FAMILY_BY_TYPE[type]]),
  );
}
