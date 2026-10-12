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
  /** File counts per category, from the same walk. */
  fileCategories?: Partial<Record<import('../constants/file-categories.js').FileCategory, number>>;
  /** Files recorded in `AnalysisJob.errors`. */
  parseErrorCount?: number;
  /**
   * What the run could not represent, and why. A COMPLETED job is not a
   * complete graph: read `completeness.incomplete` and its reasons. Absent on
   * runs recorded before this was measured, which is "unknown", not "complete".
   */
  completeness?: AnalysisCompleteness;
  /** Where the time went. Absent on runs recorded before this was measured. */
  timings?: AnalysisTimings;
  /** What the worker process used. Absent on runs recorded before this was measured. */
  resources?: AnalysisResources;
}

/**
 * Causes of known incompleteness. Each is a limit that was reached or a part
 * of the pipeline that did not finish; none is inferred from the graph's shape.
 */
export const INCOMPLETENESS_REASONS = [
  /** The walk stopped listing files at its file limit. */
  'scan_file_limit',
  /** Directories deeper than the walk's depth limit were not entered. */
  'scan_depth_limit',
  /** The walk was cancelled. */
  'scan_aborted',
  /** Directories that could not be listed; their files are unknown. */
  'unreadable_directories',
  /** Source files beyond the read's file-count limit were not read. */
  'source_file_limit',
  /** Source files over the per-file size limit were skipped. */
  'source_file_size_limit',
  /** Reading stopped at the total-size limit. */
  'source_total_size_limit',
  /** Files that could not be read or parsed (`AnalysisJob.errors`). */
  'unreadable_files',
  /** An analyzer threw; its findings are missing. */
  'analyzer_failed',
] as const;

export type IncompletenessReason = (typeof INCOMPLETENESS_REASONS)[number];

export interface AnalysisCompleteness {
  /** True when at least one reason is present. False means none was detected, not that none exists. */
  incomplete: boolean;
  reasons: IncompletenessReason[];
  /**
   * Reference occurrences with no target node, so no edge. Not incompleteness
   * by itself: references to the standard library are expected to land here.
   * `total = external + unmodelled + unknown`.
   */
  unresolvedReferences: {
    total: number;
    /** The target's package defines nothing in the index (dependency, standard library). */
    external: number;
    /** Defined in the index but not a node by design (parameters, type parameters, ambient modules). */
    unmodelled: number;
    /** In a package the index defines, yet never defined in it; not provably external. */
    unknown: number;
  };
  /**
   * Edges an analyzer proposed that the merge discarded because an endpoint
   * was not a node, or both endpoints were the same node.
   */
  droppedEdges: { total: number; byAnalyzer: Record<string, number> };
  analyzers: { run: string[]; failed: string[] };
  /** The repository walk's limits; null when the scan did not record them. */
  scan: {
    truncated: boolean;
    fileLimit: number;
    filesOverLimit: number;
    depthLimit: number;
    directoriesOverDepth: number;
    aborted: boolean;
    unreadableDirectories: number;
  } | null;
  /** The source read the analyzers worked from; null when it did not record its limits. */
  sourceRead: {
    truncated: boolean;
    candidateFiles: number;
    filesRead: number;
    bytesRead: number;
    fileLimit: { limit: number; reached: boolean; filesNotRead: number };
    fileSizeLimit: { limitBytes: number; filesSkipped: number };
    totalSizeLimit: { limitBytes: number; reached: boolean; filesNotRead: number };
  } | null;
  /** Files that could not be read or parsed; equals `parseErrorCount`. */
  unreadableFiles: number;
}

/**
 * Wall-clock durations in milliseconds from a monotonic clock
 * (`performance.now()`), rounded to 0.01 ms. A phase that did not run is
 * absent, never zero.
 */
export interface AnalysisTimings {
  /** From the start of the run to the moment the statistics were assembled, after persistence. */
  totalMs: number;
  phases: Partial<Record<AnalysisPhaseTiming, number>>;
  /** Per analyzer, in run order: `analyze()` plus merging its findings. */
  analyzers: Array<{ analyzer: string; durationMs: number; outcome: 'completed' | 'failed' }>;
  /** The indexer's own duration as its runner measured it (subprocess spawn to exit). */
  scipIndexerReportedMs?: number;
  /** `totalMs` minus the phases: status writes, workspace preparation, logging. */
  unattributedMs: number;
}

export const ANALYSIS_PHASE_TIMINGS = [
  /** Validating a local path, or cloning a git repository. */
  'repositoryLoad',
  /** Fingerprinting the working tree for freshness checks (git and file hashing). */
  'sourceRevision',
  /** Walking the tree and classifying files. */
  'scan',
  'languageDetection',
  /** The SCIP indexer, from the caller's side: resolve, spawn, wait for exit. */
  'scipIndex',
  /** Reading and decoding `index.scip`. */
  'scipDecode',
  /** The language refiner: declaration kinds, call sites, import names. */
  'scipRefine',
  /** Reading the source files the analyzers use. */
  'sourceLoad',
  /** `CodeGraphAssembler.assemble()`: every analyzer, the merges and symbol indexes. */
  'graphAssembly',
  /** `replaceProjectGraph`: deleting the old graph and inserting the new one. */
  'persist',
] as const;

export type AnalysisPhaseTiming = (typeof ANALYSIS_PHASE_TIMINGS)[number];

/**
 * The worker process, and the SCIP indexer process when it was measured. The
 * two are reported apart: their peaks need not have happened at the same time,
 * so they are never added together.
 */
export interface AnalysisResources {
  /** User and system CPU time of the worker process during the run. */
  workerCpuUserMs: number;
  workerCpuSystemMs: number;
  /**
   * Highest resident set size seen at phase boundaries. A lower bound on the
   * run's true peak: memory can rise and fall between two samples.
   */
  workerSampledPeakRssBytes: number;
  rssSamples: number;
  /**
   * The process's peak RSS since it started (`process.resourceUsage().maxRSS`).
   * An upper bound for this run only when the worker has run nothing bigger.
   */
  workerLifetimeMaxRssBytes: number;
  /** True exactly when `indexer` is present. */
  indexerMeasured: boolean;
  /**
   * The indexer subprocess, read with the operating system's `time` utility
   * when the worker runs it through a measuring runner (the benchmark harness
   * does; the default worker does not). Peak RSS is the indexer process's own.
   */
  indexer?: {
    wallMs: number;
    userCpuMs: number;
    systemCpuMs: number;
    peakRssBytes: number;
    method: 'bsd-time' | 'gnu-time';
  };
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
