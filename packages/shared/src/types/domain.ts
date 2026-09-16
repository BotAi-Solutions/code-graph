import type { AnalysisProgress } from '../constants/indexing.js';
import type { SupportedLanguage } from './language.js';
import type { IndexingError } from './project.js';

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
  /**
   * Where the run has got to. Null before the worker claims it, and on jobs
   * recorded before the pipeline reported progress at all.
   */
  progress: AnalysisProgress | null;
  /** Files that could not be read or parsed. A run completes in spite of these. */
  errors: IndexingError[];
  createdAt: string;
  updatedAt: string;
}

/**
 * What a completed run measured.
 *
 * The first five are the original pipeline counters. The rest describe the
 * project itself and are optional because a job recorded before they existed
 * simply does not have them — the UI shows what was actually measured and
 * nothing else.
 */
export interface AnalysisStats {
  documentCount: number;
  symbolCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
  /** Files the scanner walked, ignored directories excluded. */
  fileCount?: number;
  /** Of those, files in a language we can detect. */
  sourceFileCount?: number;
  directoryCount?: number;
  classCount?: number;
  functionCount?: number;
  interfaceCount?: number;
  /** Source-file counts per detected language. */
  languages?: Partial<Record<SupportedLanguage, number>>;
  /** Files recorded in `AnalysisJob.errors`. */
  parseErrorCount?: number;
}

/** Counts of graph nodes per node type, for a project. */
export type NodeTypeCounts = Partial<Record<import('./graph.js').CodeNodeType, number>>;

/** Counts of graph edges per relationship, for a project. */
export type RelationshipCounts = Partial<Record<import('./graph.js').CodeRelationship, number>>;

/**
 * A project plus everything the dashboard shows about it, assembled server side
 * so the listing is one request rather than one per project.
 */
export interface ProjectSummary extends Project {
  repository: Pick<Repository, 'sourceType' | 'sourcePath' | 'commitHash'> | null;
  latestAnalysis: Pick<
    AnalysisJob,
    'id' | 'status' | 'language' | 'startedAt' | 'completedAt' | 'error' | 'progress'
  > | null;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCounts: NodeTypeCounts;
}
