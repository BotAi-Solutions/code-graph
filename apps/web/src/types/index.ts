/**
 * The UI speaks the same vocabulary as the API. Types come from `@ckg/shared`
 * so a contract change is a compile error here rather than a runtime surprise.
 */
export type {
  AnalysisJob,
  AnalysisPhase,
  AnalysisProgress,
  AnalysisStats,
  AnalysisStatus,
  ApiErrorBody,
  ApiResponse,
  CodeEdge,
  CodeGraph,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  ConfidenceLevel,
  DirectoryEntry,
  DirectoryListing,
  EdgeEvidence,
  GraphDirection,
  GraphProjection,
  GraphProjectionId,
  IndexingError,
  NodeCategory,
  NodeDetail,
  NodeFamily,
  NodeTypeCounts,
  Project,
  ProjectMetadata,
  ProjectSummary,
  RelatedNode,
  RelationshipCounts,
  RelationshipGroup,
  Repository,
  RepositorySourceType,
  SelectedDirectory,
  SupportedLanguage,
} from '@ckg/shared';

export {
  ANALYSIS_PHASE_BY_STATUS,
  ANALYSIS_PHASE_LABELS,
  ANALYSIS_PHASES,
  analysisProgressFraction,
  ARCHITECTURAL_NODE_TYPES,
  CODE_NODE_TYPES,
  CODE_RELATIONSHIPS,
  CONFIDENCE_LEVELS,
  FAMILIES_BY_CATEGORY,
  GRAPH_DIRECTIONS,
  NODE_CATEGORIES,
  NODE_CATEGORY_BY_FAMILY,
  NODE_CATEGORY_LABELS,
  NODE_FAMILIES,
  NODE_FAMILY_BY_TYPE,
  NODE_FAMILY_LABELS,
  NODE_TYPE_LABELS,
  edgeEvidence,
  isArchitecturalNodeType,
} from '@ckg/shared';

/** Server-reported facts about the slice that came back. */
export interface GraphMeta {
  mode: 'traversal' | 'overview';
  rootNodeId: string | null;
  depth: number;
  direction: import('@ckg/shared').GraphDirection;
  projection: import('@ckg/shared').GraphProjectionId | null;
  nodeTypes: import('@ckg/shared').CodeNodeType[] | null;
  relationships: import('@ckg/shared').CodeRelationship[] | null;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
}

export interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  rootNodeId: string | null;
  nodeTypeCounts: import('@ckg/shared').NodeTypeCounts;
  relationshipCounts: import('@ckg/shared').RelationshipCounts;
}

/** Everything the toolbar controls, in one object the page owns. */
export interface GraphViewState {
  rootNodeId: string | null;
  depth: number;
  projection: import('@ckg/shared').GraphProjectionId | null;
  nodeTypes: import('@ckg/shared').CodeNodeType[];
  relationships: import('@ckg/shared').CodeRelationship[];
  direction: import('@ckg/shared').GraphDirection;
}

/** A page of search results, with the full count behind it. */
export interface GraphSearchPage {
  nodes: import('@ckg/shared').CodeNode[];
  total: number;
  limit: number;
  offset: number;
}
