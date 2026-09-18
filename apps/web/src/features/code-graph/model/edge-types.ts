import {
  RELATIONSHIPS_BY_GROUP,
  RELATIONSHIP_GROUPS,
  RELATIONSHIP_GROUP_BY_RELATIONSHIP,
  RELATIONSHIP_GROUP_LABELS,
  STRUCTURAL_RELATIONSHIPS,
} from '@ckg/shared';
import type { CodeRelationship, RelationshipGroup } from '../../../types/index.js';
import { dim } from '../utils/graph-colors.js';

/**
 * Everything the renderer needs to know about a relationship, in one table.
 *
 * Edges are the reason the graph exists, and drawing all twenty-five of them
 * with the same weight is what turns a dependency graph into a hairball. The
 * table below says, for each relationship: what it means (colour, by group),
 * how much it matters (emphasis), whether direction is worth an arrowhead, and
 * whether it is worth animating.
 *
 * ## Why colour is per group and not per relationship
 *
 * Twenty-five relationships cannot each own a distinguishable line colour — the
 * same limit that applies to node hues, and worse for a one-pixel stroke. Six
 * groups can, the group hues line up with the node families they connect, and
 * the relationship's own name is drawn on the edge wherever it carries
 * information and on any edge you select.
 */

/** Sigma edge programs, registered under these names in the engine. */
export type EdgeProgramName = 'line' | 'arrow';

/**
 * How loudly an edge speaks.
 *
 * `strong` is behaviour and data flow: what the system *does*. `medium` is
 * dependency: what it is built on. `weak` is containment and scaffolding,
 * which is true, always dense, and almost never the answer to a question.
 */
export type EdgeEmphasis = 'strong' | 'medium' | 'weak';

export interface EdgeStyle {
  group: RelationshipGroup;
  color: string;
  /** Stroke width in pixels before importance and zoom scaling. */
  width: number;
  emphasis: EdgeEmphasis;
  program: EdgeProgramName;
  /** Drawn with its name at all times, not only when selected. */
  labelled: boolean;
  /** Describes structure rather than behaviour; drawn faint. */
  structural: boolean;
  /** Carries animated flow particles when animation is on. */
  flow: boolean;
}

export const RELATIONSHIP_GROUP_COLORS: Record<RelationshipGroup, string> = {
  structure: '#46536a',
  dependency: '#6b7794',
  behaviour: '#e0682f',
  type: '#4a92ea',
  data: '#cc5f9a',
  // Gold, matching the documentation family it mostly joins: a knowledge edge
  // says "this prose is about that code", and the eye should follow it back to
  // the document it came from.
  knowledge: '#c99a45',
};

const EMPHASIS: Record<CodeRelationship, EdgeEmphasis> = {
  CONTAINS: 'weak',
  EXPORTS: 'weak',
  ACCEPTS: 'weak',
  RETURNS: 'weak',
  LINKS_TO: 'weak',

  IMPORTS: 'medium',
  DEPENDS_ON: 'medium',
  USES: 'medium',
  CONFIGURED_BY: 'medium',
  REFERENCES: 'medium',
  AUTHENTICATED_BY: 'medium',
  VALIDATES: 'medium',
  DOCUMENTS: 'medium',

  CALLS: 'strong',
  INSTANTIATES: 'strong',
  ROUTES_TO: 'strong',
  IMPLEMENTS: 'strong',
  EXTENDS: 'strong',
  READS_FROM: 'strong',
  WRITES_TO: 'strong',
  PUBLISHES: 'strong',
  SUBSCRIBES: 'strong',
  DEPENDS_ON_SERVICE: 'strong',
  // A declaration and its fulfilment are the two edges a cross-source trace is
  // made of, so both are drawn as loudly as a call.
  DEFINES: 'strong',
  IMPLEMENTED_BY: 'strong',
};

/**
 * Relationships whose name is drawn on the edge at all times.
 *
 * The architectural relationships are few on any given canvas and each says
 * something the shapes cannot: that an API *routes to* a controller rather than
 * calling it, that a repository *writes* rather than reads. `CALLS` and
 * `CONTAINS` are neither few nor surprising, so labelling them would only add
 * clutter — they are labelled on selection, like everything else.
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
  'DEFINES',
  'IMPLEMENTED_BY',
  'DOCUMENTS',
]);

/** Drawn faint because they describe structure rather than behaviour. */
export const STRUCTURAL_SET: ReadonlySet<CodeRelationship> = new Set(STRUCTURAL_RELATIONSHIPS);

/**
 * Relationships worth animating: the ones with a direction a reader actually
 * follows — a request reaching a route, a service reaching a table. Animating
 * `CONTAINS` would say only that a file still contains its functions.
 */
export const FLOW_RELATIONSHIPS: ReadonlySet<CodeRelationship> = new Set([
  'CALLS',
  'ROUTES_TO',
  'READS_FROM',
  'WRITES_TO',
  'PUBLISHES',
  'SUBSCRIBES',
  'DEPENDS_ON_SERVICE',
  'INSTANTIATES',
  'IMPLEMENTED_BY',
]);

const WIDTH: Record<EdgeEmphasis, number> = {
  strong: 1.4,
  medium: 1,
  weak: 0.7,
};

/** How far towards the void each tier is faded when nothing is selected. */
const REST_FADE: Record<EdgeEmphasis, number> = {
  strong: 0.42,
  medium: 0.58,
  weak: 0.72,
};

function buildStyle(relationship: CodeRelationship): EdgeStyle {
  const group = RELATIONSHIP_GROUP_BY_RELATIONSHIP[relationship];
  const emphasis = EMPHASIS[relationship];
  const structural = STRUCTURAL_SET.has(relationship);

  return {
    group,
    color: dim(RELATIONSHIP_GROUP_COLORS[group], REST_FADE[emphasis]),
    width: WIDTH[emphasis],
    emphasis,
    // An arrowhead costs pixels, so only the relationships whose direction is
    // the point get one. `CONTAINS` points from a file to its symbols; nobody
    // has ever needed the arrow to know that.
    program: emphasis === 'weak' ? 'line' : 'arrow',
    labelled: LABELLED_RELATIONSHIPS.has(relationship),
    structural,
    flow: FLOW_RELATIONSHIPS.has(relationship),
  };
}

export const EDGE_STYLES: Record<CodeRelationship, EdgeStyle> = Object.fromEntries(
  (Object.keys(EMPHASIS) as CodeRelationship[]).map((relationship) => [
    relationship,
    buildStyle(relationship),
  ]),
) as Record<CodeRelationship, EdgeStyle>;

export function edgeStyle(relationship: CodeRelationship): EdgeStyle {
  return EDGE_STYLES[relationship];
}

/** The undimmed group hue, for legends and the inspector. */
export function relationshipColor(relationship: CodeRelationship): string {
  return RELATIONSHIP_GROUP_COLORS[RELATIONSHIP_GROUP_BY_RELATIONSHIP[relationship]];
}

export function relationshipGroupColor(group: RelationshipGroup): string {
  return RELATIONSHIP_GROUP_COLORS[group];
}

export { RELATIONSHIPS_BY_GROUP, RELATIONSHIP_GROUPS, RELATIONSHIP_GROUP_LABELS };
