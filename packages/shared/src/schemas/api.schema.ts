import { z } from 'zod';
import {
  CODE_NODE_TYPES,
  CODE_RELATIONSHIPS,
  CONFIDENCE_LEVELS,
  EVIDENCE_METHODS,
  EVIDENCE_SOURCES,
} from '../types/graph.js';
import { NODE_CATEGORIES, NODE_FAMILIES } from '../constants/node-families.js';
import { ANALYSIS_STATUSES, REPOSITORY_SOURCE_TYPES } from '../types/domain.js';
import { SUPPORTED_LANGUAGES } from '../types/language.js';
import { FILE_CATEGORIES } from '../constants/file-categories.js';
import { ANALYSIS_PHASES } from '../constants/indexing.js';
import {
  GRAPH_DEFAULT_DEPTH,
  GRAPH_DEFAULT_DIRECTION,
  GRAPH_DEFAULT_NEIGHBOUR_LIMIT,
  GRAPH_DEFAULT_NODE_LIMIT,
  GRAPH_DEFAULT_PATH_DEPTH,
  GRAPH_DEFAULT_PATH_DIRECTION,
  GRAPH_DEFAULT_SEARCH_LIMIT,
  GRAPH_DIRECTIONS,
  GRAPH_MAX_DEPTH,
  GRAPH_MAX_NODE_LIMIT,
  GRAPH_MAX_PATH_DEPTH,
  GRAPH_MAX_SEARCH_LIMIT,
  GRAPH_PATH_DIRECTIONS,
  SOURCE_TREE_DEFAULT_LIMIT,
  SOURCE_TREE_MAX_LIMIT,
} from '../constants/graph.js';
import { GRAPH_PROJECTION_IDS } from '../constants/projections.js';
import { PROJECT_PATH_MAX_LENGTH } from '../constants/projects.js';
import {
  CODE_SEARCH_DEFAULT_LIMIT,
  CODE_SEARCH_MAX_LIMIT,
  CODE_SEARCH_MAX_QUERY_LENGTH,
} from '../constants/code-search.js';
import { SOURCE_DEFAULT_CONTEXT_LINES } from '../constants/source.js';

/**
 * Wire contracts shared by the API and the web client. Defining them once means
 * the UI cannot drift from what the server validates.
 */

/** Accepts `?x=a&x=b` and `?x=a,b` alike, then validates against an enum. */
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .preprocess((raw) => {
      if (raw === undefined || raw === null || raw === '') return undefined;
      const parts = Array.isArray(raw) ? raw : [raw];
      return parts
        .flatMap((part) => String(part).split(','))
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }, z.array(z.enum(values)).nonempty().optional())
    .optional();
}

// --- Path params ----------------------------------------------------------

export const projectIdParamSchema = z.object({
  projectId: z.uuid(),
});

export const analysisParamsSchema = z.object({
  projectId: z.uuid(),
  analysisId: z.uuid(),
});

export const graphNodeParamsSchema = z.object({
  projectId: z.uuid(),
  nodeId: z.string().min(1).max(512),
});

// --- Shared building blocks -----------------------------------------------
//
// Declared before the sections that use them: a project summary carries its
// last run's progress, so the progress schema cannot be defined further down
// beside the analysis routes.

/** Source-file counts per language. Sparse: a language absent has no key. */
export const languageCountsSchema = z.partialRecord(
  z.enum(SUPPORTED_LANGUAGES),
  z.number().int(),
);

/** File counts per category. Sparse: a category with no files has no key. */
export const fileCategoryCountsSchema = z.partialRecord(
  z.enum(FILE_CATEGORIES),
  z.number().int(),
);

/** `total: 0` means the phase cannot count its work; render it indeterminate. */
export const analysisProgressSchema = z.object({
  phase: z.enum(ANALYSIS_PHASES),
  current: z.number().int().min(0),
  total: z.number().int().min(0),
  message: z.string(),
  files: z.number().int().optional(),
  symbols: z.number().int().optional(),
  relationships: z.number().int().optional(),
  errors: z.number().int().optional(),
});

export const indexingErrorSchema = z.object({
  file: z.string(),
  error: z.string(),
});

// --- Projects -------------------------------------------------------------

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
});

/** Sparse by design: a node type absent from a project simply has no key. */
export const nodeTypeCountsSchema = z.partialRecord(z.enum(CODE_NODE_TYPES), z.number().int());

/** A project row on the dashboard: identity, source, last run and graph size. */
export const projectSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  repository: z
    .object({
      sourceType: z.enum(REPOSITORY_SOURCE_TYPES),
      sourcePath: z.string(),
      commitHash: z.string().nullable(),
    })
    .nullable(),
  latestAnalysis: z
    .object({
      id: z.uuid(),
      status: z.enum(ANALYSIS_STATUSES),
      language: z.enum(SUPPORTED_LANGUAGES).nullable(),
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
      error: z.string().nullable(),
      progress: analysisProgressSchema.nullable(),
    })
    .nullable(),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  nodeTypeCounts: nodeTypeCountsSchema,
});

export const listProjectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// --- Resolving a path to a project ----------------------------------------
//
// The inverse of the intake flow. Intake starts from a folder and creates a
// project; resolution starts from a folder and asks which project was already
// created from it — the question anything holding a working directory rather
// than a project id has to ask first.

/**
 * A path to resolve.
 *
 * Normally absolute, because the caller is naming a directory on the machine it
 * is running on. A relative path is resolved the same way a stored relative
 * `sourcePath` is — against the installation's repository base directory — so
 * that the bundled samples can be looked up by the path they were registered
 * with.
 */
export const resolveProjectQuerySchema = z.object({
  path: z.string().trim().min(1).max(PROJECT_PATH_MAX_LENGTH),
});

/**
 * One project whose indexed repository encloses the requested path.
 *
 * `relativePath` is what the path is called *inside* that repository, which is
 * the form every other route speaks: it can be handed straight to source
 * retrieval or to a graph search narrowed by file.
 */
export const projectPathMatchSchema = z.object({
  /** The full dashboard row, so a caller can tell an indexed project from an empty one without a second request. */
  project: projectSummarySchema,
  /** Absolute directory this project was indexed from, with a relative `sourcePath` already resolved. */
  repositoryRoot: z.string(),
  /**
   * The requested path relative to `repositoryRoot`, in POSIX form. Empty
   * string when the request named the repository root itself.
   */
  relativePath: z.string(),
  /** True when the requested path *is* the repository root rather than something inside it. */
  exact: z.boolean(),
});

/**
 * Every project that covers the path, most specific first.
 *
 * A list rather than one project because a repository root and a package inside
 * it may both be indexed, and picking between them is the caller's decision to
 * make with the facts in front of it — this API does not guess. An empty
 * `matches` is a successful answer meaning "nothing indexed covers this path",
 * not an error.
 */
export const projectResolutionSchema = z.object({
  /** The requested path, normalised to absolute. */
  path: z.string(),
  matches: z.array(projectPathMatchSchema),
});

// --- Repositories ---------------------------------------------------------

export const createRepositoryBodySchema = z.object({
  sourceType: z.enum(REPOSITORY_SOURCE_TYPES).default('local'),
  sourcePath: z.string().trim().min(1).max(1024),
  commitHash: z.string().trim().min(4).max(64).nullish(),
});

export const repositorySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  sourceType: z.enum(REPOSITORY_SOURCE_TYPES),
  sourcePath: z.string(),
  commitHash: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// --- Analysis -------------------------------------------------------------

export const createAnalysisBodySchema = z
  .object({
    /** Skip detection and force a specific indexer. */
    language: z.enum(SUPPORTED_LANGUAGES).optional(),
  })
  .default({});

export const analysisStatsSchema = z.object({
  documentCount: z.number().int(),
  symbolCount: z.number().int(),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  durationMs: z.number().int(),
  // Optional because a run recorded before these were measured has none, and
  // the UI shows only what was actually counted.
  fileCount: z.number().int().optional(),
  sourceFileCount: z.number().int().optional(),
  directoryCount: z.number().int().optional(),
  classCount: z.number().int().optional(),
  functionCount: z.number().int().optional(),
  interfaceCount: z.number().int().optional(),
  languages: languageCountsSchema.optional(),
  fileCategories: fileCategoryCountsSchema.optional(),
  parseErrorCount: z.number().int().optional(),
});

export const analysisJobSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  repositoryId: z.uuid(),
  status: z.enum(ANALYSIS_STATUSES),
  language: z.enum(SUPPORTED_LANGUAGES).nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  stats: analysisStatsSchema.nullable(),
  progress: analysisProgressSchema.nullable(),
  errors: z.array(indexingErrorSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// --- Local project intake -------------------------------------------------

/**
 * An absolute path chosen on the machine running the API.
 *
 * Absolute on purpose: a relative path would mean different directories to the
 * API and the worker, and "which directory did the user actually pick" is not a
 * question worth guessing at. The one exception is the repository `sourcePath`,
 * which keeps accepting relative paths so the bundled samples still work.
 */
export const directoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  // A NUL byte truncates a path inside libc; reject it before it reaches fs.
  .refine((value) => !value.includes('\u0000'), 'path must not contain a NUL byte');

export const selectedDirectorySchema = z.object({
  path: z.string(),
  name: z.string(),
});

export const browseDirectoryQuerySchema = z.object({
  /** Omitted means "start where the user's files are": their home directory. */
  path: directoryPathSchema.optional(),
});

export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isProjectRoot: z.boolean(),
});

export const directoryListingSchema = z.object({
  path: z.string(),
  parentPath: z.string().nullable(),
  isProjectRoot: z.boolean(),
  entries: z.array(directoryEntrySchema),
  truncated: z.boolean(),
});

export const inspectProjectQuerySchema = z.object({
  path: directoryPathSchema,
});

export const projectMetadataSchema = z.object({
  rootPath: z.string(),
  name: z.string(),
  totalFiles: z.number().int(),
  sourceFiles: z.number().int(),
  languages: languageCountsSchema,
  fileCategories: fileCategoryCountsSchema,
  directories: z.number().int(),
  truncated: z.boolean(),
});

// --- Graph ----------------------------------------------------------------

export const graphQuerySchema = z.object({
  /** Traversal root. When omitted the API seeds from the repository root node. */
  rootNodeId: z.string().min(1).max(512).optional(),
  depth: z.coerce.number().int().min(0).max(GRAPH_MAX_DEPTH).default(GRAPH_DEFAULT_DEPTH),
  /**
   * Named slice of the graph. Supplies the node-type and relationship filters
   * when the caller gives none, and ranks the overview. Explicit `nodeTypes` /
   * `relationships` always win over the projection's defaults.
   */
  projection: z.enum(GRAPH_PROJECTION_IDS).optional(),
  nodeTypes: csvEnum(CODE_NODE_TYPES),
  relationships: csvEnum(CODE_RELATIONSHIPS),
  direction: z.enum(GRAPH_DIRECTIONS).default(GRAPH_DEFAULT_DIRECTION),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(GRAPH_MAX_NODE_LIMIT)
    .default(GRAPH_DEFAULT_NODE_LIMIT),
});

/**
 * Search accepts a term plus optional narrowings, and pages.
 *
 * Two narrowings rather than one: `nodeTypes` is exact, and `categories` is the
 * coarse question someone actually asks — "only documentation", "only code" —
 * without having to know that documentation means `document` and
 * `document_section`. Given both, a node has to satisfy both.
 */
export const graphSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  nodeTypes: csvEnum(CODE_NODE_TYPES),
  /** Code, architecture, or repository knowledge. */
  categories: csvEnum(NODE_CATEGORIES),
  /** A repository-relative path prefix: `src/services`. */
  file: z.string().trim().max(1024).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(GRAPH_MAX_SEARCH_LIMIT)
    .default(GRAPH_DEFAULT_SEARCH_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export const codeNodeSchema = z.object({
  id: z.string(),
  projectId: z.uuid(),
  type: z.enum(CODE_NODE_TYPES),
  name: z.string(),
  qualifiedName: z.string().optional(),
  filePath: z.string().optional(),
  startLine: z.number().int().optional(),
  startCharacter: z.number().int().optional(),
  endLine: z.number().int().optional(),
  endCharacter: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const codeEdgeSchema = z.object({
  id: z.string(),
  projectId: z.uuid(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  relationship: z.enum(CODE_RELATIONSHIPS),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const codeGraphSchema = z.object({
  nodes: z.array(codeNodeSchema),
  edges: z.array(codeEdgeSchema),
});

export const neighbourQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(GRAPH_MAX_NODE_LIMIT)
    .default(GRAPH_DEFAULT_NEIGHBOUR_LIMIT),
});

/** Sparse by design: a relationship absent from a project has no key. */
export const relationshipCountsSchema = z.partialRecord(
  z.enum(CODE_RELATIONSHIPS),
  z.number().int(),
);

export const graphSummarySchema = z.object({
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  rootNodeId: z.string().nullable(),
  nodeTypeCounts: nodeTypeCountsSchema,
  relationshipCounts: relationshipCountsSchema,
});

/**
 * Why the graph believes a relationship exists, as it crosses the wire.
 *
 * Every field beyond `source` and `confidence` is optional because the producer
 * records only what it actually knows: a compiler fact has no line of its own,
 * and asking the wire format to carry one would mean inventing it.
 */
export const edgeEvidenceSchema = z.object({
  source: z.enum(EVIDENCE_SOURCES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  /** The kind of artefact the claim was read out of. */
  method: z.enum(EVIDENCE_METHODS).optional(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  /** The entity the producer matched: a table, a route, a name in prose. */
  matched: z.string().optional(),
});

/**
 * A neighbour plus how it is related, so the inspector can show
 * "CreatorRepository.create() — CALLS, scip/high" without a second request.
 *
 * `confidence` and `evidenceSource` are the original two fields and keep their
 * shape; `evidence` carries the whole record, including the file and line that
 * let a reader go and check.
 */
export const relatedNodeSchema = codeNodeSchema.extend({
  relationship: z.enum(CODE_RELATIONSHIPS),
  direction: z.enum(['incoming', 'outgoing']),
  confidence: z.enum(CONFIDENCE_LEVELS).optional(),
  evidenceSource: z.string().optional(),
  evidence: edgeEvidenceSchema.nullish(),
});

/**
 * Where a symbol is written down.
 *
 * Every field is nullable and every value is copied from what the indexer
 * recorded — a symbol whose range SCIP did not carry reports nulls rather than
 * a guessed line. `fileNodeId` is the `file` node that CONTAINS the
 * definition, which is what makes "open the file this came from" one lookup.
 */
export const definitionSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  qualifiedName: z.string().nullable(),
  type: z.enum(CODE_NODE_TYPES),
  language: z.string().nullable(),
  filePath: z.string().nullable(),
  startLine: z.number().int().nullable(),
  startCharacter: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
  endCharacter: z.number().int().nullable(),
  fileNodeId: z.string().nullable(),
});

/**
 * The identity and metadata the inspector prints, flattened out of the node's
 * free-form `metadata` bag into named fields.
 *
 * Nullable throughout on purpose: a property an analyzer never recorded is
 * `null`, never a plausible-looking default. Reading it here rather than in the
 * UI means one place decides what `metadata.httpMethod` means.
 */
export const symbolInfoSchema = z.object({
  name: z.string(),
  qualifiedName: z.string().nullable(),
  type: z.enum(CODE_NODE_TYPES),
  language: z.string().nullable(),
  filePath: z.string().nullable(),
  startLine: z.number().int().nullable(),
  startCharacter: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
  endCharacter: z.number().int().nullable(),
  exported: z.boolean().nullable(),
  visibility: z.string().nullable(),
  module: z.string().nullable(),
  framework: z.string().nullable(),
  apiRoute: z
    .object({ method: z.string().nullable(), path: z.string().nullable() })
    .nullable(),
  databaseResource: z.string().nullable(),
  externalService: z.string().nullable(),
  messagingResource: z.string().nullable(),
  scipSymbol: z.string().nullable(),
  role: z.string().nullable(),
  /**
   * What kind of thing this node is, at two altitudes. Both are derived from
   * the node type, so they are always present and never disagree with it.
   */
  category: z.enum(NODE_CATEGORIES),
  family: z.enum(NODE_FAMILIES),
  /**
   * For a node standing for a whole file: what kind of file it is, as the
   * scanner classified it. Null for everything else.
   */
  fileCategory: z.enum(FILE_CATEGORIES).nullable(),
});

/**
 * The node inspector's payload. `callers`, `callees` and `references` are the
 * original three sections and keep their exact shape; the sections added since
 * carry the relationship alongside each neighbour.
 */
export const nodeDetailSchema = z.object({
  node: codeNodeSchema,
  /** Named metadata, so the panel never parses the metadata bag itself. */
  symbol: symbolInfoSchema,
  /** Where this symbol is declared, or null when no range was indexed. */
  definition: definitionSchema.nullable(),
  callers: z.array(codeNodeSchema),
  callees: z.array(codeNodeSchema),
  references: z.array(codeNodeSchema),
  dependencies: z.array(relatedNodeSchema),
  dependents: z.array(relatedNodeSchema),
  apis: z.array(relatedNodeSchema),
  databases: z.array(relatedNodeSchema),
  /**
   * What the repository writes about this node: the sections that name it, and
   * for a document, what it names and links to.
   */
  documentation: z.array(relatedNodeSchema),
  /**
   * What declares this node and what fulfils it: the specification that
   * promises an endpoint, the migration that creates a table, the compose file
   * that defines a container, and the handler that serves a promised operation.
   */
  contracts: z.array(relatedNodeSchema),
  /** Both directions: what implements or extends this, and what it implements. */
  implementations: z.array(relatedNodeSchema),
  /** The node that CONTAINS this one — its class, its file, its directory. */
  parent: codeNodeSchema.nullable(),
  children: z.array(codeNodeSchema),
});

// --- Path -----------------------------------------------------------------

export const graphPathBodySchema = z.object({
  from: z.string().min(1).max(512),
  to: z.string().min(1).max(512),
  maxDepth: z.coerce
    .number()
    .int()
    .min(1)
    .max(GRAPH_MAX_PATH_DEPTH)
    .default(GRAPH_DEFAULT_PATH_DEPTH),
  /**
   * `outgoing` follows the flow and falls back to an undirected search when
   * nothing directed exists, saying so in the result; `both` ignores direction
   * from the start.
   */
  direction: z.enum(GRAPH_PATH_DIRECTIONS).default(GRAPH_DEFAULT_PATH_DIRECTION),
  /** Narrows which edges the walk may cross. Defaults to every relationship. */
  relationships: z.array(z.enum(CODE_RELATIONSHIPS)).nonempty().optional(),
  nodeTypes: z.array(z.enum(CODE_NODE_TYPES)).nonempty().optional(),
  /** Supplies the two filters above when the caller sends neither. */
  projection: z.enum(GRAPH_PROJECTION_IDS).optional(),
});

/** One hop of a found route: the edge taken, and the evidence behind it. */
export const graphPathStepSchema = z.object({
  edgeId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  relationship: z.enum(CODE_RELATIONSHIPS),
  /** True when the route crossed this edge against its direction. */
  reversed: z.boolean(),
  confidence: z.enum(CONFIDENCE_LEVELS).nullable(),
  evidenceSource: z.string().nullable(),
  /** The whole evidence record for this hop, when the edge carries one. */
  evidence: edgeEvidenceSchema.nullish(),
});

export const graphPathSchema = z.object({
  found: z.boolean(),
  from: z.string(),
  to: z.string(),
  /** Hops on the route. Zero when `from` and `to` are the same node. */
  depth: z.number().int(),
  /** True when no directed route existed and direction was ignored. */
  undirected: z.boolean(),
  /** The route's nodes, in order from `from` to `to`. */
  nodes: z.array(codeNodeSchema),
  /** The route's edges, in the order they are crossed. */
  edges: z.array(codeEdgeSchema),
  steps: z.array(graphPathStepSchema),
  /** Distinct relationships along the route, in order of first use. */
  relationships: z.array(z.enum(CODE_RELATIONSHIPS)),
  /** True when the search hit its node budget before proving there is no route. */
  truncated: z.boolean(),
});

// --- Code search ----------------------------------------------------------

/**
 * Searching a project's source *text*, as opposed to its graph.
 *
 * Deliberately a different thing from `/graph/search`, which matches the names
 * of things the indexer recorded. This matches the characters in the files: it
 * finds a string in a comment, in a template, in a config value and in a
 * language nothing in this system can parse — none of which is in the graph.
 */
export const codeSearchQuerySchema = z.object({
  /** A literal string. Not a regular expression, not a glob, not a pattern. */
  q: z.string().min(1).max(CODE_SEARCH_MAX_QUERY_LENGTH),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CODE_SEARCH_MAX_LIMIT)
    .default(CODE_SEARCH_DEFAULT_LIMIT),
});

/**
 * One occurrence.
 *
 * One result per occurrence rather than per line, so `column` always points at
 * a specific match and a line containing a term three times is three results —
 * which is what makes `total` a count of occurrences rather than a count of
 * lines that happen to contain one.
 */
export const codeSearchMatchSchema = z.object({
  /** Repository-relative POSIX path. Nothing about the host's layout leaks. */
  filePath: z.string(),
  /** 1-based, as an editor counts. */
  line: z.number().int(),
  /** 0-based, matching `startCharacter` everywhere else in this API. */
  column: z.number().int(),
  /** The matched text, which for a literal search is always the query itself. */
  match: z.string(),
  /** The line the match sits on, windowed around it when the line is very long. */
  lineText: z.string(),
  /** True when `lineText` is a window rather than the whole line. */
  lineTruncated: z.boolean(),
});

// --- Source tree ----------------------------------------------------------

/**
 * One level of the repository tree, derived from the `file` and `directory`
 * nodes the indexer already produced. Asking for a level at a time is what
 * keeps opening a project from shipping its whole tree.
 */
export const sourceTreeQuerySchema = z.object({
  /** Repository-relative directory. Omitted or empty means the root. */
  path: z.string().trim().max(1024).default(''),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SOURCE_TREE_MAX_LIMIT)
    .default(SOURCE_TREE_DEFAULT_LIMIT),
});

export const sourceTreeEntrySchema = z.object({
  /** Repository-relative POSIX path. Never an absolute machine path. */
  path: z.string(),
  name: z.string(),
  type: z.enum(['directory', 'file']),
  /** The graph node for this entry, so clicking it can select it. */
  nodeId: z.string().nullable(),
});

export const sourceTreeSchema = z.object({
  path: z.string(),
  parentPath: z.string().nullable(),
  entries: z.array(sourceTreeEntrySchema),
  truncated: z.boolean(),
});

// --- Source retrieval -----------------------------------------------------

/**
 * A window onto one indexed file.
 *
 * Either `file` or `nodeId` says which file; `nodeId` additionally supplies the
 * range, so "show me this symbol" needs nothing else. Both may be given, in
 * which case the node only contributes its range.
 */
export const sourceQuerySchema = z
  .object({
    /** Repository-relative path. Absolute paths and `..` are rejected. */
    file: z.string().trim().min(1).max(1024).optional(),
    /** A graph node, whose indexed range becomes the window. */
    nodeId: z.string().min(1).max(512).optional(),
    /** 1-based and inclusive, matching how an editor counts. */
    startLine: z.coerce.number().int().min(1).optional(),
    endLine: z.coerce.number().int().min(1).optional(),
    /** Extra lines either side of a symbol range. Ignored for an explicit range. */
    context: z.coerce.number().int().min(0).max(200).default(SOURCE_DEFAULT_CONTEXT_LINES),
  })
  .refine(
    (value) => value.file !== undefined || value.nodeId !== undefined,
    'either file or nodeId is required',
  )
  .refine(
    (value) =>
      value.startLine === undefined ||
      value.endLine === undefined ||
      value.endLine >= value.startLine,
    'endLine must not be before startLine',
  );

export const sourceLineSchema = z.object({
  line: z.number().int(),
  text: z.string(),
});

export const sourceSchema = z.object({
  /** Repository-relative, so nothing about the host's layout leaks. */
  file: z.string(),
  language: z.string().nullable(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  /** Lines in the whole file, so a viewer can say "38-62 of 410". */
  totalLines: z.number().int(),
  /** True when the requested range was wider than one response may carry. */
  truncated: z.boolean(),
  /** The symbol range that motivated the window, when a node id was given. */
  highlight: z
    .object({
      nodeId: z.string().nullable(),
      startLine: z.number().int(),
      startCharacter: z.number().int().nullable(),
      endLine: z.number().int(),
      endCharacter: z.number().int().nullable(),
    })
    .nullable(),
  lines: z.array(sourceLineSchema),
});

export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export type ResolveProjectQuery = z.infer<typeof resolveProjectQuerySchema>;
export type ProjectPathMatch = z.infer<typeof projectPathMatchSchema>;
export type ProjectResolution = z.infer<typeof projectResolutionSchema>;
export type CreateRepositoryBody = z.infer<typeof createRepositoryBodySchema>;
export type CreateAnalysisBody = z.infer<typeof createAnalysisBodySchema>;
export type BrowseDirectoryQuery = z.infer<typeof browseDirectoryQuerySchema>;
export type InspectProjectQuery = z.infer<typeof inspectProjectQuerySchema>;
export type GraphQuery = z.infer<typeof graphQuerySchema>;
export type GraphSearchQuery = z.infer<typeof graphSearchQuerySchema>;
export type WireEdgeEvidence = z.infer<typeof edgeEvidenceSchema>;
export type NeighbourQuery = z.infer<typeof neighbourQuerySchema>;
export type NodeDetail = z.infer<typeof nodeDetailSchema>;
export type RelatedNode = z.infer<typeof relatedNodeSchema>;
export type GraphSummary = z.infer<typeof graphSummarySchema>;
export type Definition = z.infer<typeof definitionSchema>;
export type SymbolInfo = z.infer<typeof symbolInfoSchema>;
export type GraphPathBody = z.infer<typeof graphPathBodySchema>;
export type GraphPathStep = z.infer<typeof graphPathStepSchema>;
export type GraphPath = z.infer<typeof graphPathSchema>;
export type SourceTreeQuery = z.infer<typeof sourceTreeQuerySchema>;
export type SourceTreeEntry = z.infer<typeof sourceTreeEntrySchema>;
export type SourceTree = z.infer<typeof sourceTreeSchema>;
export type CodeSearchQuery = z.infer<typeof codeSearchQuerySchema>;
export type CodeSearchMatch = z.infer<typeof codeSearchMatchSchema>;
export type SourceQuery = z.infer<typeof sourceQuerySchema>;
export type SourceLine = z.infer<typeof sourceLineSchema>;
export type SourceWindow = z.infer<typeof sourceSchema>;

export const GRAPH_QUERY_DEFAULTS = {
  depth: GRAPH_DEFAULT_DEPTH,
  limit: GRAPH_DEFAULT_NODE_LIMIT,
  direction: GRAPH_DEFAULT_DIRECTION,
} as const;
