/**
 * Transport-level shape of the repository knowledge graph.
 *
 * These types describe what crosses the API boundary. The richer domain model
 * (builders, analyzers, traversal, identity rules) lives in `@ckg/graph` and is
 * defined in terms of these same unions so there is exactly one vocabulary.
 */

/**
 * Core code nodes — things a compiler knows about — followed by architectural
 * nodes, which describe how the system is put together, and then repository
 * nodes, which describe what the repository says about itself in prose,
 * configuration and specifications.
 *
 * The split matters because the three come from different kinds of evidence:
 * core nodes are SCIP-derived, architectural nodes are derived by source
 * analyzers reading the AST, and repository nodes are derived by parsing
 * declarative files — Markdown, JSON, YAML, SQL — that no compiler reads.
 *
 * ## Provenance is not the same axis as display
 *
 * These three groups say *how a node came to be known*. The families and
 * categories in `constants/node-families.ts` say *how a node is drawn and
 * grouped for a reader*, and the two deliberately do not line up: an
 * `api_endpoint` is known from a specification (repository provenance) but is
 * an architectural thing to look at, and a `column` is read out of a migration
 * but belongs beside the table it is part of. Forcing one axis to match the
 * other would make one of them wrong.
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
] as const;

/**
 * Nodes that exist because a repository is more than its code.
 *
 * Each one is here because the existing vocabulary could not say the thing
 * accurately:
 *
 * - `document` / `document_section` — a Markdown file is not indexed by SCIP,
 *   so there is no `file` node for it; `config` was the existing precedent for
 *   "a file the compiler never saw", and prose deserves its own.
 * - `config_property` — a promoted key inside a configuration file. The file
 *   itself is a `config` node, which moved here from the architectural group
 *   when the graph learned to read what is inside one: a compose file is a
 *   declaration about the repository, not a piece of its runtime architecture,
 *   and it is now described by the same parsers as the rest of this group.
 * - `api_spec` / `api_endpoint` — a *declared* operation is not the same thing
 *   as an *implemented* route. Collapsing them into `api` would hide the
 *   endpoints a specification promises and the code does not deliver.
 * - `column` — a table's members. `table` existed; its columns did not.
 * - `container` — a deployment unit declared by compose or a Dockerfile.
 *   `service` already means "the thing this repository builds", which is a
 *   different claim.
 */
export const REPOSITORY_NODE_TYPES = [
  'config',
  'document',
  'document_section',
  'config_property',
  'api_spec',
  'api_endpoint',
  'column',
  'container',
] as const;

export const CODE_NODE_TYPES = [
  ...CORE_CODE_NODE_TYPES,
  ...ARCHITECTURAL_NODE_TYPES,
  ...REPOSITORY_NODE_TYPES,
] as const;

export type CoreCodeNodeType = (typeof CORE_CODE_NODE_TYPES)[number];
export type ArchitecturalNodeType = (typeof ARCHITECTURAL_NODE_TYPES)[number];
export type RepositoryNodeType = (typeof REPOSITORY_NODE_TYPES)[number];
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

/**
 * Relationships that only a declarative source can observe.
 *
 * Four, and no more, because the existing vocabulary already covered most of
 * what the repository layer needs and a synonym is worse than nothing:
 *
 * - `DEFINES` — a declarative file brings a resource into existence: a compose
 *   file defines a container, a migration defines a table, a specification
 *   defines an endpoint. `CONTAINS` is structural nesting, which is a weaker
 *   and different claim.
 * - `DOCUMENTS` — prose describes an entity.
 * - `LINKS_TO` — a document links to another file in the repository.
 * - `IMPLEMENTED_BY` — a declared contract is fulfilled by code. Deliberately
 *   *not* the inverse of the existing `IMPLEMENTS`: a trace runs from the
 *   contract inwards, and a path search that has to walk one edge backwards is
 *   a path search that will not find it.
 *
 * Notably absent: `CONFIGURES`, because `CONFIGURED_BY` already exists and is
 * already emitted; `READS`/`WRITES`, because `READS_FROM`/`WRITES_TO` do;
 * `MENTIONS`, because it is `DOCUMENTS` at a lower confidence and confidence is
 * already recorded on every edge; and `EXPOSES`, because it is `DEFINES`.
 */
export const REPOSITORY_RELATIONSHIPS = [
  'DEFINES',
  'DOCUMENTS',
  'LINKS_TO',
  'IMPLEMENTED_BY',
] as const;

export const CODE_RELATIONSHIPS = [
  ...CORE_CODE_RELATIONSHIPS,
  ...ARCHITECTURAL_RELATIONSHIPS,
  ...REPOSITORY_RELATIONSHIPS,
] as const;

export type CoreCodeRelationship = (typeof CORE_CODE_RELATIONSHIPS)[number];
export type ArchitecturalRelationship = (typeof ARCHITECTURAL_RELATIONSHIPS)[number];
export type RepositoryRelationship = (typeof REPOSITORY_RELATIONSHIPS)[number];
export type CodeRelationship = (typeof CODE_RELATIONSHIPS)[number];

/**
 * Which analyzer observed a node or edge. Recorded on every edge so a
 * relationship can always be traced back to the thing that observed it — which
 * is what keeps the graph honest as more analyzers are added.
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
  'document-analyzer',
  'configuration-analyzer',
  'openapi-analyzer',
  'sql-analyzer',
] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * *How* the fact was extracted, as distinct from *who* extracted it.
 *
 * `source` names an analyzer, which is an implementation detail that will keep
 * changing; the method names the kind of artefact the claim was read out of,
 * which is what a reader actually wants to know when they ask why the graph
 * believes something. One analyzer can use more than one: the configuration
 * analyzer reads JSON and YAML, and says which.
 */
export const EVIDENCE_METHODS = [
  'scip',
  'ast',
  'markdown',
  'json',
  'yaml',
  'sql',
  'openapi',
  'configuration',
  'graph',
] as const;

export type EvidenceMethod = (typeof EVIDENCE_METHODS)[number];

/**
 * How much the producer trusts the relationship.
 *
 * - `high`   — a compiler fact, or an unambiguous declarative one (a decorator
 *              argument, an import specifier, a resolved call target, a key in
 *              a specification).
 * - `medium` — a real observation that needed a resolution step which could in
 *              principle be wrong (an aggregate lifted to a container, a SQL
 *              statement built from a template literal, a prose name matched to
 *              the one declaration in the repository that carries it).
 * - `low`    — reserved. Nothing in the pipeline emits it; a relationship that
 *              would only be `low` is not emitted at all.
 *
 * The numeric equivalents and the policy that assigns them live in
 * `constants/confidence.ts`, so no analyzer invents its own scale.
 */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/**
 * Why the graph believes a relationship exists.
 *
 * `source` and `confidence` are required; everything else is recorded when the
 * producer actually knows it. A location is not optional out of laziness — a
 * SCIP-derived `CALLS` edge is located by its endpoints, and inventing a line
 * number for it would be worse than leaving it out.
 */
export interface EdgeEvidence {
  source: EvidenceSource;
  confidence: ConfidenceLevel;
  /** The kind of artefact the claim was read out of. */
  method?: EvidenceMethod;
  /** Repository-relative POSIX path the claim was read from. */
  file?: string;
  /** 1-based line, matching how an editor counts. */
  line?: number;
  /** 0-based character offset, matching every editor API. */
  column?: number;
  /** The entity or resource the producer matched: a table, a route, a name. */
  matched?: string;
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

export function isRepositoryNodeType(type: CodeNodeType): type is RepositoryNodeType {
  return (REPOSITORY_NODE_TYPES as readonly string[]).includes(type);
}

export function isArchitecturalRelationship(
  relationship: CodeRelationship,
): relationship is ArchitecturalRelationship {
  return (ARCHITECTURAL_RELATIONSHIPS as readonly string[]).includes(relationship);
}

export function isRepositoryRelationship(
  relationship: CodeRelationship,
): relationship is RepositoryRelationship {
  return (REPOSITORY_RELATIONSHIPS as readonly string[]).includes(relationship);
}

/**
 * Reads the evidence an edge was recorded with, if any.
 *
 * Returns null when the metadata does not name a known analyzer, which is the
 * honest answer for an edge written by a version of the pipeline this build
 * does not know about. Optional fields come back only when they were recorded.
 */
export function edgeEvidence(edge: Pick<CodeEdge, 'metadata'>): EdgeEvidence | null {
  const metadata = edge.metadata;
  const source = metadata?.source;
  const confidence = metadata?.confidence;

  if (typeof source !== 'string' || !(EVIDENCE_SOURCES as readonly string[]).includes(source)) {
    return null;
  }
  const level =
    typeof confidence === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(confidence)
      ? (confidence as ConfidenceLevel)
      : 'high';

  const evidence: EdgeEvidence = { source: source as EvidenceSource, confidence: level };

  const method = metadata?.method;
  if (typeof method === 'string' && (EVIDENCE_METHODS as readonly string[]).includes(method)) {
    evidence.method = method as EvidenceMethod;
  }
  if (typeof metadata?.file === 'string') evidence.file = metadata.file;
  if (typeof metadata?.line === 'number') evidence.line = metadata.line;
  if (typeof metadata?.column === 'number') evidence.column = metadata.column;
  if (typeof metadata?.matched === 'string') evidence.matched = metadata.matched;

  return evidence;
}
