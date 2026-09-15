/**
 * The UI speaks the same vocabulary as the API. Types come from `@ckg/shared`
 * so a contract change is a compile error here rather than a runtime surprise.
 */
export type {
  AnalysisJob,
  NodeFamily,
  NodeTypeCounts,
  ProjectSummary,
  AnalysisStatus,
  ApiErrorBody,
  ApiResponse,
  CodeEdge,
  CodeGraph,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  NodeDetail,
  Project,
  Repository,
  RepositorySourceType,
} from '@ckg/shared';

export {
  CODE_NODE_TYPES,
  CODE_RELATIONSHIPS,
  NODE_FAMILIES,
  NODE_FAMILY_BY_TYPE,
  NODE_FAMILY_LABELS,
} from '@ckg/shared';

export interface GraphMeta {
  mode: 'traversal' | 'overview';
  rootNodeId: string | null;
  depth: number;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
}

export interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  rootNodeId: string | null;
  nodeTypeCounts: import('@ckg/shared').NodeTypeCounts;
}

/** Everything the toolbar controls, in one object the page owns. */
export interface GraphViewState {
  rootNodeId: string | null;
  depth: number;
  nodeTypes: import('@ckg/shared').CodeNodeType[];
  relationships: import('@ckg/shared').CodeRelationship[];
}
