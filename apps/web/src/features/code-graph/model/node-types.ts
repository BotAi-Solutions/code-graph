import { NODE_FAMILY_BY_TYPE, NODE_TYPE_LABELS } from '@ckg/shared';
import type { CodeNodeType, NodeFamily } from '../../../types/index.js';
import { nodeColor } from '../utils/graph-colors.js';

/**
 * Everything the renderer needs to know about a node type, in one table.
 *
 * Nothing outside this file decides what a node looks like. A component that
 * wants a colour, a silhouette or a label asks here, which is what keeps the
 * canvas, the legend, the minimap, the search results and the inspector
 * describing the same graph.
 */

/**
 * Silhouettes the WebGL node program can draw. The numbers are the shape ids
 * the fragment shader branches on, so the order is load-bearing — see
 * `engine/node-programs.ts`.
 */
export const NODE_SHAPES = {
  circle: 0,
  square: 1,
  diamond: 2,
  hexagon: 3,
  triangle: 4,
  pentagon: 5,
  ring: 6,
  squareRing: 7,
  capsule: 8,
  rhomboid: 9,
  star: 10,
  cross: 11,
  page: 12,
  bar: 13,
  hollowTriangle: 14,
  hollowPentagon: 15,
  hollowHexagon: 16,
  lines: 17,
  pillar: 18,
} as const;

export type NodeShape = keyof typeof NODE_SHAPES;

export interface NodeStyle {
  shape: NodeShape;
  /** Radius before importance scaling, in Sigma's graph units. */
  size: number;
  color: string;
  /** How much halo this type carries at equal importance, 0–1. */
  glow: number;
  /** How much this type deserves a label when space is contested, 0–1. */
  labelPriority: number;
  /**
   * Which zoom tier the type belongs to. 0 survives the furthest view, 2 only
   * appears close in. This is what stops a repository of ten thousand methods
   * from rendering as ten thousand identical specks at first paint.
   */
  detailTier: 0 | 1 | 2;
  /** The type's own contribution to importance, before graph structure. */
  weight: number;
}

/**
 * Shape is the *primary* channel for the architectural types and a secondary
 * one for code, because hue cannot separate twenty-eight things (see
 * `utils/graph-colors.ts`). Every architectural silhouette below is one no code
 * type uses, so an API is never separated from a class by colour alone.
 */
const SHAPES: Record<CodeNodeType, NodeShape> = {
  repository: 'square',
  directory: 'square',
  file: 'square',
  module: 'square',

  class: 'circle',
  interface: 'hexagon',
  type: 'diamond',
  enum: 'diamond',

  function: 'circle',
  method: 'circle',

  variable: 'diamond',
  property: 'diamond',
  parameter: 'diamond',

  api: 'triangle',
  service: 'pentagon',
  external_service: 'ring',
  database: 'capsule',
  table: 'squareRing',
  queue: 'rhomboid',
  event: 'star',
  config: 'cross',

  // The repository types pair with the architectural silhouette they relate
  // to, hollowed out: a declared endpoint is the outline of a served route, a
  // specification the outline of a service. A hollow shape reads as "promised,
  // not necessarily delivered", which is exactly what a contract is.
  api_endpoint: 'hollowTriangle',
  api_spec: 'hollowPentagon',
  container: 'hollowHexagon',
  // A pillar for a column, two stacked lines for a section of prose, one line
  // for one setting. Every silhouette here is unused by any code type, so no
  // repository node is told apart from a class by colour alone.
  column: 'pillar',
  document: 'page',
  document_section: 'lines',
  config_property: 'bar',
};

/**
 * Radius in screen pixels, before importance scaling.
 *
 * Small on purpose. A node is a mark saying "something is here and it is this
 * kind of thing"; it is the *arrangement* that carries the information, and a
 * canvas of forty-pixel discs is a canvas where the edges, the clusters and the
 * empty space between modules have nowhere to be read. The range below runs
 * from a five-pixel parameter to a twenty-pixel repository once importance has
 * been applied, which is enough to tell twelve silhouettes apart at rest and
 * still leaves the layout visible underneath.
 */
const SIZES: Record<CodeNodeType, number> = {
  repository: 10,
  directory: 5.5,
  file: 5,
  module: 6.5,

  class: 6.5,
  interface: 6,
  type: 3.8,
  enum: 3.8,

  function: 4.5,
  method: 3.8,

  variable: 2.8,
  property: 2.8,
  parameter: 2.5,

  api: 7.5,
  service: 9,
  external_service: 7,
  database: 8,
  table: 6,
  queue: 6,
  event: 5.5,
  config: 4.5,

  api_spec: 8,
  api_endpoint: 6.5,
  container: 7,
  // The interiors of the three types above them, and sized to say so: a column
  // must not out-draw its table, nor a section its document.
  column: 2.8,
  document: 6.5,
  document_section: 3.4,
  config_property: 2.6,
};

const GLOW: Record<CodeNodeType, number> = {
  repository: 0.9,
  directory: 0.4,
  file: 0.35,
  module: 0.7,

  class: 0.6,
  interface: 0.55,
  type: 0.25,
  enum: 0.25,

  function: 0.4,
  method: 0.3,

  variable: 0.15,
  property: 0.15,
  parameter: 0.1,

  api: 0.9,
  service: 1,
  external_service: 0.8,
  database: 0.9,
  table: 0.65,
  queue: 0.75,
  event: 0.75,
  config: 0.4,

  api_spec: 0.8,
  api_endpoint: 0.7,
  container: 0.8,
  column: 0.12,
  document: 0.6,
  document_section: 0.2,
  config_property: 0.1,
};

const LABEL_PRIORITY: Record<CodeNodeType, number> = {
  repository: 1,
  directory: 0.6,
  file: 0.5,
  module: 0.8,

  class: 0.7,
  interface: 0.65,
  type: 0.3,
  enum: 0.3,

  function: 0.45,
  method: 0.35,

  variable: 0.15,
  property: 0.15,
  parameter: 0.1,

  api: 0.9,
  service: 0.95,
  external_service: 0.85,
  database: 0.9,
  table: 0.75,
  queue: 0.8,
  event: 0.75,
  config: 0.55,

  api_spec: 0.85,
  api_endpoint: 0.8,
  container: 0.85,
  column: 0.2,
  document: 0.7,
  document_section: 0.4,
  config_property: 0.15,
};

/**
 * Semantic zoom tiers.
 *
 * Tier 0 is the architecture: things a reader looks for before they know what
 * they are looking for. Tier 1 is behaviour. Tier 2 is the inside of a
 * function, which is noise until you have already chosen where to look.
 */
const DETAIL_TIER: Record<CodeNodeType, 0 | 1 | 2> = {
  repository: 0,
  directory: 0,
  file: 0,
  module: 0,

  class: 0,
  interface: 0,
  type: 1,
  enum: 1,

  function: 1,
  method: 1,

  variable: 2,
  property: 2,
  parameter: 2,

  api: 0,
  service: 0,
  external_service: 0,
  database: 0,
  table: 0,
  queue: 0,
  event: 0,
  config: 0,

  api_spec: 0,
  api_endpoint: 0,
  container: 0,
  document: 0,
  // Tier 2: the interior of a document, a config file or a table. True, dense,
  // and noise until someone has already chosen where to look.
  document_section: 2,
  config_property: 2,
  column: 2,
};

/** How much being *this kind of thing* counts towards importance. */
const WEIGHT: Record<CodeNodeType, number> = {
  repository: 1,
  directory: 0.35,
  file: 0.3,
  module: 0.6,

  class: 0.6,
  interface: 0.5,
  type: 0.2,
  enum: 0.2,

  function: 0.35,
  method: 0.25,

  variable: 0.08,
  property: 0.08,
  parameter: 0.05,

  api: 0.85,
  service: 1,
  external_service: 0.7,
  database: 0.85,
  table: 0.55,
  queue: 0.6,
  event: 0.55,
  config: 0.3,

  api_spec: 0.75,
  api_endpoint: 0.6,
  container: 0.7,
  document: 0.45,
  document_section: 0.12,
  config_property: 0.08,
  column: 0.08,
};

export const NODE_STYLES: Record<CodeNodeType, NodeStyle> = Object.fromEntries(
  (Object.keys(SHAPES) as CodeNodeType[]).map((type) => [
    type,
    {
      shape: SHAPES[type],
      size: SIZES[type],
      color: nodeColor(type),
      glow: GLOW[type],
      labelPriority: LABEL_PRIORITY[type],
      detailTier: DETAIL_TIER[type],
      weight: WEIGHT[type],
    } satisfies NodeStyle,
  ]),
) as Record<CodeNodeType, NodeStyle>;

export function nodeStyle(type: CodeNodeType): NodeStyle {
  return NODE_STYLES[type];
}

/** Node types grouped by family, in the fixed order the legend and bar use. */
export const TYPES_BY_FAMILY: Record<NodeFamily, CodeNodeType[]> = {
  types: ['class', 'interface', 'type', 'enum'],
  callables: ['function', 'method'],
  data: ['variable', 'property', 'parameter'],
  structure: ['repository', 'directory', 'file', 'module'],
  services: ['api', 'api_endpoint', 'api_spec', 'service', 'external_service'],
  resources: ['database', 'table', 'column', 'queue', 'event', 'container'],
  documentation: ['document', 'document_section'],
  configuration: ['config', 'config_property'],
};

export function familyOf(type: CodeNodeType): NodeFamily {
  return NODE_FAMILY_BY_TYPE[type];
}

/** Short badge text for a node type: what the inspector and search show. */
export function nodeTypeLabel(type: CodeNodeType): string {
  return NODE_TYPE_LABELS[type];
}

/** A node's own best label: callables are marked as callable. */
export function nodeLabel(node: { name: string; type: CodeNodeType }): string {
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
