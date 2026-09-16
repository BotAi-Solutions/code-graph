/**
 * Transport-level shape of the code knowledge graph.
 *
 * These types describe what crosses the API boundary. The richer domain model
 * (builders, analyzers, traversal, identity rules) lives in `@ckg/graph` and is
 * defined in terms of these same unions so there is exactly one vocabulary.
 */

/**
 * Core code nodes — things a compiler knows about — followed by architectural
 * nodes, which describe how the system is put together. The split matters
 * because the two come from different sources of evidence: core nodes are
 * SCIP-derived, architectural nodes are derived by source analyzers.
 */
export const CORE_CODE_NODE_TYPES = [
  'repository',
  'directory',
  'file',
  'module',
  'class',
  'interface',
  'function',
  'method',
  'variable',
  'type',
  'enum',
  'property',
  'parameter',
] as const;

export const ARCHITECTURAL_NODE_TYPES = [
  'api',
  'service',
  'database',
  'table',
  'queue',
  'event',
  'external_service',
  'config',
] as const;

export const CODE_NODE_TYPES = [
  ...CORE_CODE_NODE_TYPES,
  ...ARCHITECTURAL_NODE_TYPES,
] as const;

export type CoreCodeNodeType = (typeof CORE_CODE_NODE_TYPES)[number];
export type ArchitecturalNodeType = (typeof ARCHITECTURAL_NODE_TYPES)[number];
export type CodeNodeType = (typeof CODE_NODE_TYPES)[number];

/**
 * Relationships between code symbols. Every one of these is derived from either
 * a compiler fact (SCIP) or a syntactic fact (an analyzer reading the AST);
 * none is inferred from names looking alike.
 */
export const CORE_CODE_RELATIONSHIPS = [
  'CONTAINS',
  'IMPORTS',
  'EXPORTS',
  'CALLS',
  'REFERENCES',
  'IMPLEMENTS',
  'EXTENDS',
  'INSTANTIATES',
  'RETURNS',
  'ACCEPTS',
  'DEPENDS_ON',
] as const;

/** Relationships between architectural nodes, or between code and them. */
export const ARCHITECTURAL_RELATIONSHIPS = [
  'ROUTES_TO',
  'USES',
  'READS_FROM',
  'WRITES_TO',
  'PUBLISHES',
  'SUBSCRIBES',
  'CONFIGURED_BY',
  'AUTHENTICATED_BY',
  'VALIDATES',
  'DEPENDS_ON_SERVICE',
] as const;

export const CODE_RELATIONSHIPS = [
  ...CORE_CODE_RELATIONSHIPS,
  ...ARCHITECTURAL_RELATIONSHIPS,
] as const;

export type CoreCodeRelationship = (typeof CORE_CODE_RELATIONSHIPS)[number];
export type ArchitecturalRelationship = (typeof ARCHITECTURAL_RELATIONSHIPS)[number];
export type CodeRelationship = (typeof CODE_RELATIONSHIPS)[number];

/**
 * Where a node or edge came from. Recorded on every edge so a relationship can
 * always be traced back to the thing that observed it — which is what keeps the
 * graph honest as more analyzers are added.
 */
export const EVIDENCE_SOURCES = [
  'scip',
  'graph-builder',
  'file-analyzer',
  'import-analyzer',
  'structure-analyzer',
  'api-analyzer',
  'database-analyzer',
  'external-service-analyzer',
  'messaging-analyzer',
  'framework-analyzer',
] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * How much the producer trusts the relationship.
 *
 * - `high`   — a compiler fact, or an unambiguous syntactic one (a decorator
 *              argument, an import specifier, a resolved call target).
 * - `medium` — a real observation that needed a resolution step which could in
 *              principle be wrong (an aggregate lifted to a container, a SQL
 *              statement built from a template literal).
 * - `low`    — reserved. Nothing in the pipeline emits it today; a relationship
 *              that would only be `low` is not emitted at all.
 */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface EdgeEvidence {
  source: EvidenceSource;
  confidence: ConfidenceLevel;
}

export interface CodeNode {
  id: string;
  projectId: string;
  type: CodeNodeType;
  name: string;
  /**
   * Dotted path that names the node within its scope: `UserService.getUser`
   * for a method, `POST /users` for an API route, `postgres.users` for a table.
   * Absent where it would only repeat `name`.
   */
  qualifiedName?: string;
  filePath?: string;
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
  metadata?: Record<string, unknown>;
}

export interface CodeEdge {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationship: CodeRelationship;
  metadata?: Record<string, unknown>;
}

export interface CodeGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

export function isCodeNodeType(value: string): value is CodeNodeType {
  return (CODE_NODE_TYPES as readonly string[]).includes(value);
}

export function isCodeRelationship(value: string): value is CodeRelationship {
  return (CODE_RELATIONSHIPS as readonly string[]).includes(value);
}

export function isArchitecturalNodeType(type: CodeNodeType): type is ArchitecturalNodeType {
  return (ARCHITECTURAL_NODE_TYPES as readonly string[]).includes(type);
}

export function isArchitecturalRelationship(
  relationship: CodeRelationship,
): relationship is ArchitecturalRelationship {
  return (ARCHITECTURAL_RELATIONSHIPS as readonly string[]).includes(relationship);
}

/** Reads the evidence an edge was recorded with, if any. */
export function edgeEvidence(edge: Pick<CodeEdge, 'metadata'>): EdgeEvidence | null {
  const source = edge.metadata?.source;
  const confidence = edge.metadata?.confidence;

  if (typeof source !== 'string' || !(EVIDENCE_SOURCES as readonly string[]).includes(source)) {
    return null;
  }
  const level =
    typeof confidence === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(confidence)
      ? (confidence as ConfidenceLevel)
      : 'high';

  return { source: source as EvidenceSource, confidence: level };
}
