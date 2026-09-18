import type { CodeRelationship } from '../types/graph.js';

/**
 * Relationships grouped by what they say about the repository.
 *
 * Twenty-five relationships cannot each own a distinguishable edge colour, so
 * the canvas colours edges by *group* and prints the relationship name as a
 * label where it matters. The same grouping organises the relationship filter,
 * which would otherwise be a flat list of twenty-five chips.
 */
export const RELATIONSHIP_GROUPS = [
  'structure',
  'dependency',
  'behaviour',
  'type',
  'data',
  'knowledge',
] as const;

export type RelationshipGroup = (typeof RELATIONSHIP_GROUPS)[number];

export const RELATIONSHIP_GROUP_LABELS: Record<RelationshipGroup, string> = {
  structure: 'Structure',
  dependency: 'Dependency',
  behaviour: 'Behaviour',
  type: 'Type',
  data: 'Data',
  knowledge: 'Knowledge',
};

export const RELATIONSHIP_GROUP_BY_RELATIONSHIP: Record<CodeRelationship, RelationshipGroup> = {
  CONTAINS: 'structure',
  EXPORTS: 'structure',
  DEFINES: 'structure',

  IMPORTS: 'dependency',
  DEPENDS_ON: 'dependency',
  DEPENDS_ON_SERVICE: 'dependency',
  USES: 'dependency',
  CONFIGURED_BY: 'dependency',

  CALLS: 'behaviour',
  INSTANTIATES: 'behaviour',
  ROUTES_TO: 'behaviour',
  IMPLEMENTED_BY: 'behaviour',
  AUTHENTICATED_BY: 'behaviour',
  VALIDATES: 'behaviour',

  REFERENCES: 'type',
  IMPLEMENTS: 'type',
  EXTENDS: 'type',
  ACCEPTS: 'type',
  RETURNS: 'type',

  READS_FROM: 'data',
  WRITES_TO: 'data',
  PUBLISHES: 'data',
  SUBSCRIBES: 'data',

  DOCUMENTS: 'knowledge',
  LINKS_TO: 'knowledge',
};

/** Relationships in each group, in the fixed order filters and legends use. */
export const RELATIONSHIPS_BY_GROUP: Record<RelationshipGroup, CodeRelationship[]> = {
  structure: ['CONTAINS', 'EXPORTS', 'DEFINES'],
  dependency: ['IMPORTS', 'DEPENDS_ON', 'DEPENDS_ON_SERVICE', 'USES', 'CONFIGURED_BY'],
  behaviour: [
    'CALLS',
    'INSTANTIATES',
    'ROUTES_TO',
    'IMPLEMENTED_BY',
    'AUTHENTICATED_BY',
    'VALIDATES',
  ],
  type: ['REFERENCES', 'IMPLEMENTS', 'EXTENDS', 'ACCEPTS', 'RETURNS'],
  data: ['READS_FROM', 'WRITES_TO', 'PUBLISHES', 'SUBSCRIBES'],
  knowledge: ['DOCUMENTS', 'LINKS_TO'],
};

/** Describe structure rather than behaviour; drawn dashed on the canvas. */
export const STRUCTURAL_RELATIONSHIPS: readonly CodeRelationship[] = [
  'CONTAINS',
  'EXPORTS',
  'IMPORTS',
];

/**
 * Relationships that describe how the system behaves, used to rank the
 * overview: containment always wins a degree contest (every symbol in a file is
 * CONTAINed by it) while saying nothing about what the code does.
 */
export const BEHAVIOURAL_RELATIONSHIPS: readonly CodeRelationship[] = [
  'CALLS',
  'REFERENCES',
  'IMPLEMENTS',
  'EXTENDS',
  'IMPORTS',
  'INSTANTIATES',
  'ROUTES_TO',
  'USES',
  'READS_FROM',
  'WRITES_TO',
  'PUBLISHES',
  'SUBSCRIBES',
  'DEPENDS_ON',
  'DEPENDS_ON_SERVICE',
  'IMPLEMENTED_BY',
  'DEFINES',
  'DOCUMENTS',
];

/** Followed to answer "what does this node depend on / what depends on it". */
export const DEPENDENCY_RELATIONSHIPS: readonly CodeRelationship[] = [
  'DEPENDS_ON',
  'DEPENDS_ON_SERVICE',
  'IMPORTS',
  'USES',
];

export function relationshipGroupOf(relationship: CodeRelationship): RelationshipGroup {
  return RELATIONSHIP_GROUP_BY_RELATIONSHIP[relationship];
}
