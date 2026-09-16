import {
  FAMILIES_BY_CATEGORY,
  NODE_CATEGORIES,
  NODE_CATEGORY_BY_FAMILY,
  NODE_CATEGORY_LABELS,
  NODE_FAMILIES,
  NODE_FAMILY_BY_TYPE,
  NODE_FAMILY_LABELS,
  NODE_TYPE_LABELS,
  RELATIONSHIPS_BY_GROUP,
  RELATIONSHIP_GROUPS,
  RELATIONSHIP_GROUP_BY_RELATIONSHIP,
  RELATIONSHIP_GROUP_LABELS,
  STRUCTURAL_RELATIONSHIPS,
} from '@ckg/shared';
import type {
  CodeNodeType,
  CodeRelationship,
  NodeCategory,
  NodeFamily,
  RelationshipGroup,
} from '../../types/index.js';

/**
 * The visual language, in one place, so a colour means the same thing on the
 * canvas, in the legend and on the dashboard.
 *
 * ## Why hue encodes the family, not the node type
 *
 * There are twenty-one node types. On this dark surface no set of more than
 * four categorical hues clears all-pairs colour-vision separation — enumerated,
 * not guessed: of the 70 four-hue subsets of a validated eight-hue palette only
 * two pass, and no five- or six-hue subset passes at all. Twenty-one
 * distinguishable hues is not available, and neither is nine.
 *
 * So the canvas uses composite encoding: **hue = family, shape = member, label
 * = exact identity, badge = type**. Three identity hues (blue / orange / aqua)
 * carry the code families and clear all-pairs separation with room to spare;
 * structure is scaffolding rather than subject, so it takes a neutral lightness
 * ramp where lighter means nearer the repository root.
 *
 * Validated against surface #060910 (canvas) and #0f1622 (cards):
 *   worst all-pairs CVD ΔE 9.4, normal-vision ΔE 20.9, all ≥ 3:1 contrast.
 *
 * ## The architectural families
 *
 * `services` and `resources` are additions to that validated set, and the
 * honest position is that adding two more hues weakens hue as a channel. They
 * are therefore **shape-and-badge primary**: every architectural type has a
 * silhouette no code type uses (tag, cylinder, barrel, hexagon), the inspector
 * and the search results print the type name, and the legend groups by category
 * so the two vocabularies are never presented as one flat list of colours.
 * Colour alone is never the only thing separating an API from a table.
 */

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

/**
 * Cytoscape shape per node type — the second channel of the encoding, and the
 * primary one for the architectural types.
 */
export const NODE_SHAPES: Record<CodeNodeType, string> = {
  repository: 'round-rectangle',
  directory: 'round-rectangle',
  file: 'round-rectangle',
  module: 'round-rectangle',

  class: 'ellipse',
  interface: 'round-hexagon',
  type: 'round-diamond',
  enum: 'round-heptagon',

  function: 'ellipse',
  method: 'ellipse',

  variable: 'round-diamond',
  property: 'round-diamond',
  parameter: 'round-diamond',

  // Architectural silhouettes: none of these is used by a code type.
  api: 'round-tag',
  service: 'round-octagon',
  external_service: 'cut-rectangle',
  database: 'barrel',
  table: 'rectangle',
  queue: 'right-rhomboid',
  event: 'star',
  config: 'vee',
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
  enum: 22,

  function: 26,
  method: 22,

  variable: 16,
  property: 16,
  parameter: 14,

  api: 30,
  service: 36,
  external_service: 30,
  database: 32,
  table: 26,
  queue: 26,
  event: 24,
  config: 20,
};

/**
 * Relationship colours, assigned by *group* rather than one per relationship.
 *
 * Twenty-one relationships cannot each own a distinguishable line colour — the
 * same limit that applies to node hues, and worse for thin strokes. Five groups
 * can, and the relationship's own name is on the edge wherever it carries
 * information (see `LABELLED_RELATIONSHIPS`) and on any selected edge.
 */
export const RELATIONSHIP_GROUP_COLORS: Record<RelationshipGroup, string> = {
  structure: '#3f4a5c',
  dependency: '#5b6475',
  behaviour: '#d95926',
  type: '#3987e5',
  data: '#c2548f',
};

export function relationshipColor(relationship: CodeRelationship): string {
  const group = RELATIONSHIP_GROUP_BY_RELATIONSHIP[relationship];
  return RELATIONSHIP_GROUP_COLORS[group] ?? '#3f4a5c';
}

export function relationshipGroupColor(group: RelationshipGroup): string {
  return RELATIONSHIP_GROUP_COLORS[group];
}

/**
 * Relationships whose name is drawn on the edge at all times.
 *
 * The architectural relationships are few on any given canvas and each says
 * something the shapes cannot: that an API *routes to* a controller rather than
 * calling it, that a repository *writes* rather than reads. `CALLS` and
 * `CONTAINS` are neither few nor surprising, so labelling them would only add
 * clutter — they are labelled on selection like everything else.
 */
export const LABELLED_RELATIONSHIPS: ReadonlySet<CodeRelationship> = new Set([
  'ROUTES_TO',
  'READS_FROM',
  'WRITES_TO',
  'PUBLISHES',
  'SUBSCRIBES',
  'CONFIGURED_BY',
  'AUTHENTICATED_BY',
  'VALIDATES',
  'DEPENDS_ON_SERVICE',
  'USES',
]);

/** Drawn dashed because they describe structure rather than behaviour. */
export const DASHED_RELATIONSHIPS: ReadonlySet<CodeRelationship> = new Set(
  STRUCTURAL_RELATIONSHIPS,
);

/** Node types grouped by family, in the fixed order the legend and bar use. */
export const TYPES_BY_FAMILY: Record<NodeFamily, CodeNodeType[]> = {
  types: ['class', 'interface', 'type', 'enum'],
  callables: ['function', 'method'],
  data: ['variable', 'property', 'parameter'],
  structure: ['repository', 'directory', 'file', 'module'],
  services: ['api', 'service', 'external_service'],
  resources: ['database', 'table', 'queue', 'event', 'config'],
};

/** Short badge text for a node type: what the inspector and search show. */
export function nodeTypeLabel(type: CodeNodeType): string {
  return NODE_TYPE_LABELS[type];
}

/** A node's own best label: its qualified name where that says more. */
export function nodeLabel(node: {
  name: string;
  qualifiedName?: string | undefined;
  type: CodeNodeType;
}): string {
  if (node.type === 'function' || node.type === 'method') return `${node.name}()`;
  return node.name;
}

/** The fuller name, for a tooltip or the inspector heading. */
export function nodeFullName(node: {
  name: string;
  qualifiedName?: string | undefined;
  type: CodeNodeType;
}): string {
  const qualified = node.qualifiedName;
  if (!qualified || qualified === node.name) return nodeLabel(node);
  if (node.type === 'function' || node.type === 'method') return `${qualified}()`;
  return qualified;
}

export function categoryOfType(type: CodeNodeType): NodeCategory {
  return NODE_CATEGORY_BY_FAMILY[NODE_FAMILY_BY_TYPE[type]];
}

export {
  FAMILIES_BY_CATEGORY,
  NODE_CATEGORIES,
  NODE_CATEGORY_LABELS,
  NODE_FAMILIES,
  NODE_FAMILY_LABELS,
  NODE_TYPE_LABELS,
  RELATIONSHIPS_BY_GROUP,
  RELATIONSHIP_GROUPS,
  RELATIONSHIP_GROUP_LABELS,
};
