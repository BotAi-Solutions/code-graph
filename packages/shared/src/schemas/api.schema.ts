import { z } from 'zod';
import { CODE_NODE_TYPES, CODE_RELATIONSHIPS, CONFIDENCE_LEVELS } from '../types/graph.js';
import { ANALYSIS_STATUSES, REPOSITORY_SOURCE_TYPES } from '../types/domain.js';
import { SUPPORTED_LANGUAGES } from '../types/language.js';
import {
  GRAPH_DEFAULT_DEPTH,
  GRAPH_DEFAULT_DIRECTION,
  GRAPH_DEFAULT_NEIGHBOUR_LIMIT,
  GRAPH_DEFAULT_NODE_LIMIT,
  GRAPH_DEFAULT_SEARCH_LIMIT,
  GRAPH_DIRECTIONS,
  GRAPH_MAX_DEPTH,
  GRAPH_MAX_NODE_LIMIT,
  GRAPH_MAX_SEARCH_LIMIT,
} from '../constants/graph.js';
import { GRAPH_PROJECTION_IDS } from '../constants/projections.js';

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
  createdAt: z.string(),
  updatedAt: z.string(),
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

/** Search accepts a term plus an optional node-type narrowing, and pages. */
export const graphSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  nodeTypes: csvEnum(CODE_NODE_TYPES),
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
 * A neighbour plus how it is related, so the inspector can show
 * "CreatorRepository.create() — CALLS, scip/high" without a second request.
 */
export const relatedNodeSchema = codeNodeSchema.extend({
  relationship: z.enum(CODE_RELATIONSHIPS),
  direction: z.enum(['incoming', 'outgoing']),
  confidence: z.enum(CONFIDENCE_LEVELS).optional(),
  evidenceSource: z.string().optional(),
});

/**
 * The node inspector's payload. `callers`, `callees` and `references` are the
 * original three sections and keep their exact shape; the sections added since
 * carry the relationship alongside each neighbour.
 */
export const nodeDetailSchema = z.object({
  node: codeNodeSchema,
  callers: z.array(codeNodeSchema),
  callees: z.array(codeNodeSchema),
  references: z.array(codeNodeSchema),
  dependencies: z.array(relatedNodeSchema),
  dependents: z.array(relatedNodeSchema),
  apis: z.array(relatedNodeSchema),
  databases: z.array(relatedNodeSchema),
});

export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export type CreateRepositoryBody = z.infer<typeof createRepositoryBodySchema>;
export type CreateAnalysisBody = z.infer<typeof createAnalysisBodySchema>;
export type GraphQuery = z.infer<typeof graphQuerySchema>;
export type GraphSearchQuery = z.infer<typeof graphSearchQuerySchema>;
export type NeighbourQuery = z.infer<typeof neighbourQuerySchema>;
export type NodeDetail = z.infer<typeof nodeDetailSchema>;
export type RelatedNode = z.infer<typeof relatedNodeSchema>;
export type GraphSummary = z.infer<typeof graphSummarySchema>;

export const GRAPH_QUERY_DEFAULTS = {
  depth: GRAPH_DEFAULT_DEPTH,
  limit: GRAPH_DEFAULT_NODE_LIMIT,
  direction: GRAPH_DEFAULT_DIRECTION,
} as const;
