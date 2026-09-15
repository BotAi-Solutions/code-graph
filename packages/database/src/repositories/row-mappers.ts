import type {
  AnalysisJob,
  AnalysisStats,
  AnalysisStatus,
  CodeEdge,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  Project,
  Repository,
  RepositorySourceType,
  SupportedLanguage,
} from '@ckg/shared';

/**
 * Row -> domain mappers. Postgres columns are snake_case and timestamps come
 * back as `Date`; the domain model is camelCase with ISO strings. Keeping the
 * translation in one place means no other layer ever sees a raw row.
 */

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RepositoryRow {
  id: string;
  project_id: string;
  source_type: string;
  source_path: string;
  commit_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AnalysisJobRow {
  id: string;
  project_id: string;
  repository_id: string;
  status: string;
  language: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  error: string | null;
  stats: AnalysisStats | null;
  created_at: Date;
  updated_at: Date;
}

export interface CodeNodeRow {
  id: string;
  project_id: string;
  node_type: string;
  name: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  metadata: Record<string, unknown> | null;
}

export interface CodeEdgeRow {
  id: string;
  project_id: string;
  source_node_id: string;
  target_node_id: string;
  relationship: string;
  metadata: Record<string, unknown> | null;
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type as RepositorySourceType,
    sourcePath: row.source_path,
    commitHash: row.commit_hash,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toAnalysisJob(row: AnalysisJobRow): AnalysisJob {
  return {
    id: row.id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    status: row.status as AnalysisStatus,
    language: (row.language as SupportedLanguage | null) ?? null,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    error: row.error,
    stats: row.stats,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toCodeNode(row: CodeNodeRow): CodeNode {
  const node: CodeNode = {
    id: row.id,
    projectId: row.project_id,
    type: row.node_type as CodeNodeType,
    name: row.name,
  };
  if (row.file_path !== null) node.filePath = row.file_path;
  if (row.start_line !== null) node.startLine = row.start_line;
  if (row.end_line !== null) node.endLine = row.end_line;
  if (row.metadata && Object.keys(row.metadata).length > 0) node.metadata = row.metadata;
  return node;
}

export function toCodeEdge(row: CodeEdgeRow): CodeEdge {
  const edge: CodeEdge = {
    id: row.id,
    projectId: row.project_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    relationship: row.relationship as CodeRelationship,
  };
  if (row.metadata && Object.keys(row.metadata).length > 0) edge.metadata = row.metadata;
  return edge;
}

export const CODE_NODE_COLUMNS =
  'id, project_id, node_type, name, file_path, start_line, end_line, metadata';
export const CODE_EDGE_COLUMNS =
  'id, project_id, source_node_id, target_node_id, relationship, metadata';
