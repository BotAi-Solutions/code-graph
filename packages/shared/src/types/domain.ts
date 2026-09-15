import type { SupportedLanguage } from './language.js';

export const REPOSITORY_SOURCE_TYPES = ['local', 'git'] as const;
export type RepositorySourceType = (typeof REPOSITORY_SOURCE_TYPES)[number];

export const ANALYSIS_STATUSES = [
  'QUEUED',
  'INDEXING',
  'PARSING',
  'BUILDING_GRAPH',
  'PERSISTING',
  'COMPLETED',
  'FAILED',
] as const;

export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/** Statuses from which no further transition happens. */
export const TERMINAL_ANALYSIS_STATUSES: readonly AnalysisStatus[] = ['COMPLETED', 'FAILED'];

export function isTerminalAnalysisStatus(status: AnalysisStatus): boolean {
  return TERMINAL_ANALYSIS_STATUSES.includes(status);
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  projectId: string;
  sourceType: RepositorySourceType;
  sourcePath: string;
  commitHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisJob {
  id: string;
  projectId: string;
  repositoryId: string;
  status: AnalysisStatus;
  language: SupportedLanguage | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  stats: AnalysisStats | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisStats {
  documentCount: number;
  symbolCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}

/** Counts of graph nodes per node type, for a project. */
export type NodeTypeCounts = Partial<Record<import('./graph.js').CodeNodeType, number>>;

/**
 * A project plus everything the dashboard shows about it, assembled server side
 * so the listing is one request rather than one per project.
 */
export interface ProjectSummary extends Project {
  repository: Pick<Repository, 'sourceType' | 'sourcePath' | 'commitHash'> | null;
  latestAnalysis: Pick<
    AnalysisJob,
    'id' | 'status' | 'language' | 'startedAt' | 'completedAt' | 'error'
  > | null;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCounts: NodeTypeCounts;
}
