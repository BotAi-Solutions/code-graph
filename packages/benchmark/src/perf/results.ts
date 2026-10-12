import type { AnalysisStats } from '@ckg/shared';
import { summarize, type Summary } from './statistics.js';

/**
 * What the performance benchmark records, and how it is written down.
 *
 * One record per indexing run, kept whatever its outcome: a failed run and an
 * incomplete one are results too, and dropping them would make the rest look
 * better than they are. Query measurements are separate records in a separate
 * file; indexing and querying are never summarised together.
 *
 * A value that was not measured is `null`, never `0`.
 *
 * ## Schema 2
 *
 * Changed from 1: run kinds are `initial-index` and `re-index` (were `cold`
 * and `warm`, which suggested caches had been reset), decided by whether the
 * project held a graph before the run; records carry timestamps and the
 * database state they started from; query records carry a stable key that
 * does not depend on project-scoped ids, a round, and a warm-up flag; the
 * report records the database, its applied migrations and the series.
 */

export const PERF_REPORT_SCHEMA = 2;

export type RunKind = 'initial-index' | 're-index';
export type RunOutcome = 'completed' | 'failed' | 'harness_error';

/**
 * What state a run started from. Every field is a statement about something
 * the harness did or did not do; nothing here is a guess.
 */
export interface CacheState {
  /** The indexing ran in a newly started process (no JIT or module cache from earlier runs). */
  freshProcess: boolean;
  /** The project already held a graph, so persistence replaced it. */
  projectGraphPreexisting: boolean;
  /** The analysis workspace (where the index is written) was new. */
  freshWorkspace: boolean;
  /** The checkout existed before this harness invocation started. */
  checkoutPreexisting: boolean;
  /**
   * The checkout was restored to exactly its pinned commit before the run
   * (scip-typescript writes a tsconfig.json into a project that has none) and
   * verified to have nothing else in it but prepared node_modules.
   */
  checkoutPristine: boolean;
  /** `VACUUM (ANALYZE)` of the graph tables ran immediately before the run. */
  databaseSettled: boolean;
  /** The OS page cache was dropped. The harness cannot do this without privileges, and does not. */
  osPageCacheReset: false;
  /** PostgreSQL's buffer cache was reset (a server restart). The harness does not do this. */
  databaseBufferCacheReset: false;
}

/** The SCIP indexer process, measured by `MeasuringCommandRunner`. */
export interface ScipMeasurement {
  command: string;
  /** Arguments, with paths as given; no environment is recorded. */
  args: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  wallMs: number | null;
  userCpuMs: number | null;
  systemCpuMs: number | null;
  peakRssBytes: number | null;
  method: string | null;
  measurementError: string | null;
}

/** What the child process that ran one indexing reports back. */
export interface IndexRunOutput {
  outcome: Exclude<RunOutcome, 'harness_error'>;
  error: string | null;
  jobId: string | null;
  jobStatus: string | null;
  stats: AnalysisStats | null;
  scip: ScipMeasurement | null;
  persistence: 'postgres' | 'in-memory';
}

export interface DatabaseSize {
  databaseBytes: number;
  /** `pg_total_relation_size`: table, indexes and TOAST. Whole tables, every project in them. */
  tables: Record<string, number>;
  /** Bytes of this project's rows (`pg_column_size` of each row), excluding indexes. */
  projectRowBytes: number;
}

/** One table, from `pg_stat_user_tables` and `pg_total_relation_size`. */
export interface TableState {
  relation: string;
  liveTuples: number;
  deadTuples: number;
  totalBytes: number;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
}

/** The benchmark database at one moment, so two measurements can be compared honestly. */
export interface DatabaseState {
  capturedAt: string;
  databaseBytes: number;
  tables: TableState[];
}

export interface SettleStep {
  /** `VACUUM (ANALYZE)` of these tables. */
  tables: string[];
  durationMs: number;
}

export interface RepositoryFacts {
  id: string;
  url: string;
  commit: string;
  ref: string;
  tier: string;
  subdirectory: string | null;
  /** Tracked files under the indexed directory. Null when they could not be counted. */
  trackedFiles: number | null;
  /** Lines in tracked TypeScript and JavaScript files under it. */
  sourceLines: number | null;
  sourceFiles: number | null;
}

export interface RunRecord {
  repository: RepositoryFacts;
  run: {
    /** Order within this repository: the initial phase first, then the re-index phase. */
    index: number;
    /**
     * The harness's plan for the run. `initial`: a new project and, unless
     * `--no-settle`, a settled database. `reindex`: the last project, as left
     * by the run before. A re-index-phase run that finds no graph (because
     * indexing failed before it) is `kind: 'initial-index'` with neither.
     */
    phase: 'initial' | 'reindex';
    /** What the database said: whether the project held a graph before the run. */
    kind: RunKind;
    /** 1-based within its kind. */
    sample: number;
    startedAt: string;
    cacheState: CacheState;
  };
  outcome: RunOutcome;
  error: string | null;
  jobStatus: string | null;
  persistence: 'postgres' | 'in-memory' | null;
  /** From the child's spawn to its exit, as the harness saw it: includes process start-up. */
  harnessWallMs: number;
  stats: AnalysisStats | null;
  scip: ScipMeasurement | null;
  /** The database before the run (after settling, when it was settled). */
  databaseBefore: DatabaseState | null;
  settle: SettleStep | null;
  /** Sizes after the run. */
  database: DatabaseSize | null;
}

export type QueryKind = 'search' | 'node_detail' | 'traverse' | 'path';

export interface QueryRecord {
  repositoryId: string;
  projectId: string;
  kind: QueryKind;
  /**
   * Identifies the question independently of project-scoped ids: the target's
   * type, name and file, and the parameters. Equal across invocations for the
   * same graph, so records from two reports can be paired.
   */
  key: string;
  /** The parameters sent, ids included. */
  params: Record<string, string | number>;
  /** 1-based; each round runs against a freshly started API process. */
  round: number;
  /** Warm-up passes are recorded but never summarised. */
  warmup: boolean;
  /** Pass number within the round, warm-up passes included, 0-based. */
  iteration: number;
  at: string;
  status: number | null;
  ok: boolean;
  /** Request sent to body fully read, measured by the client. */
  clientMs: number | null;
  /** From the response's `Server-Timing: app;dur=…`, when present. */
  serverMs: number | null;
  resultCount: number | null;
  truncated: boolean | null;
  responseBytes: number | null;
  error: string | null;
}

export interface EnvironmentInfo {
  machine: {
    cpuModel: string;
    cores: number;
    memoryBytes: number;
    os: string;
    osRelease: string;
    kernel: string;
    arch: string;
  };
  tools: Record<string, string | null>;
  /**
   * The benchmarked tool's own commit, whether its tree had uncommitted
   * changes, and a fingerprint of those changes (sha256 of the diff against
   * HEAD and of every untracked file) so a dirty run is still identifiable.
   */
  toolCommit: { sha: string | null; dirty: boolean | null; treeFingerprint: string | null };
}

export interface DatabaseInfo {
  /** The database name only; never the connection string. */
  name: string;
  serverVersion: string | null;
  migrations: Array<{ name: string; checksum: string }>;
}

/** How a repository's checkout was prepared, for a dependency-prepared series. */
export interface PreparationRecord {
  repositoryId: string;
  profile: string;
  package: string;
  version: string;
  tarball: string;
  integrity: string;
  integrityVerified: boolean;
  /** sha256 over the sorted (path, sha256) list of every prepared file. */
  preparedTreeSha256: string;
  preparedFiles: number;
  scriptsRun: false;
}

export interface PerfReport {
  schema: typeof PERF_REPORT_SCHEMA;
  generatedAt: string;
  environment: EnvironmentInfo;
  database: DatabaseInfo | null;
  configuration: Record<string, unknown>;
  /** Set when the harness itself failed; every run measured before it is still in `runs`. */
  fatalError: string | null;
  repositories: Array<{ id: string; status: 'ok' | 'checkout_failed' | 'preparation_failed' | 'error' | 'skipped'; error: string | null }>;
  preparations: PreparationRecord[];
  runs: RunRecord[];
  queries: QueryRecord[];
  queryWorkloads: QueryWorkloadRecord[];
  summary: { indexing: IndexingSummary[]; queries: QuerySummary[] };
}

/** The circumstances of one repository's query workload. */
export interface QueryWorkloadRecord {
  repositoryId: string;
  projectId: string;
  targets: Array<{ type: string; name: string; filePath: string | null }>;
  settle: SettleStep | null;
  databaseBefore: DatabaseState | null;
  databaseAfter: DatabaseState | null;
  rounds: Array<{ round: number; apiPid: number | null; apiStartedAt: string; warmupPasses: number; measuredPasses: number }>;
}

// --- summaries ------------------------------------------------------------

/** Metrics summarised per repository and run kind, over completed runs. */
const INDEXING_METRICS: ReadonlyArray<[string, (record: RunRecord) => number | null | undefined]> = [
  ['totalMs', (r) => r.stats?.timings?.totalMs],
  ['phase.repositoryLoad', (r) => r.stats?.timings?.phases.repositoryLoad],
  ['phase.sourceRevision', (r) => r.stats?.timings?.phases.sourceRevision],
  ['phase.scan', (r) => r.stats?.timings?.phases.scan],
  ['phase.scipIndex', (r) => r.stats?.timings?.phases.scipIndex],
  ['phase.scipDecode', (r) => r.stats?.timings?.phases.scipDecode],
  ['phase.scipRefine', (r) => r.stats?.timings?.phases.scipRefine],
  ['phase.sourceLoad', (r) => r.stats?.timings?.phases.sourceLoad],
  ['phase.graphAssembly', (r) => r.stats?.timings?.phases.graphAssembly],
  ['phase.persist', (r) => r.stats?.timings?.phases.persist],
  ['scip.wallMs', (r) => r.scip?.wallMs],
  ['scip.cpuMs', (r) => sum(r.scip?.userCpuMs, r.scip?.systemCpuMs)],
  ['scip.peakRssBytes', (r) => r.scip?.peakRssBytes],
  ['worker.cpuMs', (r) => sum(r.stats?.resources?.workerCpuUserMs, r.stats?.resources?.workerCpuSystemMs)],
  ['worker.peakRssBytes', (r) => r.stats?.resources?.workerLifetimeMaxRssBytes],
  ['graph.nodes', (r) => r.stats?.nodeCount],
  ['graph.edges', (r) => r.stats?.edgeCount],
  ['graph.projectRowBytes', (r) => r.database?.projectRowBytes],
  ['unresolved.total', (r) => r.stats?.completeness?.unresolvedReferences.total],
];

export interface IndexingSummary {
  repositoryId: string;
  kind: RunKind;
  phase: 'initial' | 'reindex';
  runs: number;
  completed: number;
  failed: number;
  /** Completed, but with known incompleteness. Included in the metrics, and counted here. */
  incomplete: number;
  metrics: Record<string, Summary>;
}

export function summarizeRuns(records: readonly RunRecord[]): IndexingSummary[] {
  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = `${record.repository.id}\u0000${record.run.kind}\u0000${record.run.phase}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  return [...groups.values()].map((group) => {
    const first = group[0] as RunRecord;
    const completed = group.filter((record) => record.outcome === 'completed');
    const metrics: Record<string, Summary> = {};
    for (const [name, read] of INDEXING_METRICS) metrics[name] = summarize(completed.map(read));

    return {
      repositoryId: first.repository.id,
      kind: first.run.kind,
      phase: first.run.phase,
      runs: group.length,
      completed: completed.length,
      failed: group.length - completed.length,
      incomplete: completed.filter((record) => record.stats?.completeness?.incomplete === true).length,
      metrics,
    };
  });
}

export interface QuerySummary {
  repositoryId: string;
  kind: QueryKind;
  key: string;
  /** Measured (non-warm-up) executions per round. */
  rounds: Array<{ round: number; count: number; failed: number; clientMs: Summary; serverMs: Summary }>;
  /** All measured executions of every round together. */
  pooled: { count: number; failed: number; clientMs: Summary; serverMs: Summary };
  /**
   * Median server time of the last round over the first: the run-to-run
   * noise floor for this question, from identical work on one database state.
   * Null with fewer than two rounds or without server timings.
   */
  roundToRoundRatio: number | null;
  resultCount: number | null;
  truncated: boolean | null;
}

export function summarizeQueries(records: readonly QueryRecord[]): QuerySummary[] {
  const groups = new Map<string, QueryRecord[]>();
  for (const record of records) {
    if (record.warmup) continue;
    const key = `${record.repositoryId}\u0000${record.kind}\u0000${record.key}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  return [...groups.values()].map((group) => {
    const head = group[0] as QueryRecord;
    const roundNumbers = [...new Set(group.map((record) => record.round))].sort((a, b) => a - b);
    const describe = (subset: QueryRecord[]) => {
      const ok = subset.filter((record) => record.ok);
      return {
        count: subset.length,
        failed: subset.length - ok.length,
        clientMs: summarize(ok.map((record) => record.clientMs)),
        serverMs: summarize(ok.map((record) => record.serverMs)),
      };
    };
    const rounds = roundNumbers.map((round) => ({ round, ...describe(group.filter((record) => record.round === round)) }));
    const first = rounds[0]?.serverMs.median ?? null;
    const last = rounds.length > 1 ? (rounds[rounds.length - 1]?.serverMs.median ?? null) : null;
    const ok = group.find((record) => record.ok) ?? null;

    return {
      repositoryId: head.repositoryId,
      kind: head.kind,
      key: head.key,
      rounds,
      pooled: describe(group),
      roundToRoundRatio: first !== null && last !== null && first > 0 ? last / first : null,
      resultCount: ok?.resultCount ?? null,
      truncated: ok?.truncated ?? null,
    };
  });
}

/** A stable string for a parameter record: keys sorted, values as given. */
export function paramsKey(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&');
}

// --- CSV --------------------------------------------------------------------

const tableOf = (state: DatabaseState | null, relation: string): TableState | undefined =>
  state?.tables.find((table) => table.relation === relation);

/** One row per indexing run. Column order is part of the format. */
export const RUN_CSV_COLUMNS: ReadonlyArray<[string, (record: RunRecord) => unknown]> = [
  ['repository', (r) => r.repository.id],
  ['url', (r) => r.repository.url],
  ['commit', (r) => r.repository.commit],
  ['subdirectory', (r) => r.repository.subdirectory],
  ['tracked_files', (r) => r.repository.trackedFiles],
  ['source_files', (r) => r.repository.sourceFiles],
  ['source_lines', (r) => r.repository.sourceLines],
  ['run_index', (r) => r.run.index],
  ['run_phase', (r) => r.run.phase],
  ['run_kind', (r) => r.run.kind],
  ['run_sample', (r) => r.run.sample],
  ['started_at', (r) => r.run.startedAt],
  ['project_graph_preexisting', (r) => r.run.cacheState.projectGraphPreexisting],
  ['checkout_preexisting', (r) => r.run.cacheState.checkoutPreexisting],
  ['checkout_pristine', (r) => r.run.cacheState.checkoutPristine],
  ['database_settled', (r) => r.run.cacheState.databaseSettled],
  ['edges_dead_tuples_before', (r) => tableOf(r.databaseBefore, 'code_edges')?.deadTuples],
  ['edges_live_tuples_before', (r) => tableOf(r.databaseBefore, 'code_edges')?.liveTuples],
  ['edges_bytes_before', (r) => tableOf(r.databaseBefore, 'code_edges')?.totalBytes],
  ['outcome', (r) => r.outcome],
  ['error', (r) => r.error],
  ['job_status', (r) => r.jobStatus],
  ['persistence', (r) => r.persistence],
  ['harness_wall_ms', (r) => r.harnessWallMs],
  ['total_ms', (r) => r.stats?.timings?.totalMs],
  ['duration_ms', (r) => r.stats?.durationMs],
  ['repository_load_ms', (r) => r.stats?.timings?.phases.repositoryLoad],
  ['source_revision_ms', (r) => r.stats?.timings?.phases.sourceRevision],
  ['scan_ms', (r) => r.stats?.timings?.phases.scan],
  ['language_detection_ms', (r) => r.stats?.timings?.phases.languageDetection],
  ['scip_index_ms', (r) => r.stats?.timings?.phases.scipIndex],
  ['scip_decode_ms', (r) => r.stats?.timings?.phases.scipDecode],
  ['scip_refine_ms', (r) => r.stats?.timings?.phases.scipRefine],
  ['source_load_ms', (r) => r.stats?.timings?.phases.sourceLoad],
  ['graph_assembly_ms', (r) => r.stats?.timings?.phases.graphAssembly],
  ['persist_ms', (r) => r.stats?.timings?.phases.persist],
  ['unattributed_ms', (r) => r.stats?.timings?.unattributedMs],
  ['worker_cpu_user_ms', (r) => r.stats?.resources?.workerCpuUserMs],
  ['worker_cpu_system_ms', (r) => r.stats?.resources?.workerCpuSystemMs],
  ['worker_sampled_peak_rss_bytes', (r) => r.stats?.resources?.workerSampledPeakRssBytes],
  ['worker_process_peak_rss_bytes', (r) => r.stats?.resources?.workerLifetimeMaxRssBytes],
  ['scip_exit_code', (r) => r.scip?.exitCode],
  ['scip_timed_out', (r) => r.scip?.timedOut],
  ['scip_wall_ms', (r) => r.scip?.wallMs],
  ['scip_cpu_user_ms', (r) => r.scip?.userCpuMs],
  ['scip_cpu_system_ms', (r) => r.scip?.systemCpuMs],
  ['scip_peak_rss_bytes', (r) => r.scip?.peakRssBytes],
  ['scip_measurement_error', (r) => r.scip?.measurementError],
  ['files_scanned', (r) => r.stats?.fileCount],
  ['files_read', (r) => r.stats?.completeness?.sourceRead?.filesRead],
  ['nodes', (r) => r.stats?.nodeCount],
  ['edges', (r) => r.stats?.edgeCount],
  ['unresolved_total', (r) => r.stats?.completeness?.unresolvedReferences.total],
  ['unresolved_external', (r) => r.stats?.completeness?.unresolvedReferences.external],
  ['unresolved_unmodelled', (r) => r.stats?.completeness?.unresolvedReferences.unmodelled],
  ['unresolved_unknown', (r) => r.stats?.completeness?.unresolvedReferences.unknown],
  ['dropped_edges', (r) => r.stats?.completeness?.droppedEdges.total],
  ['failed_analyzers', (r) => r.stats?.completeness?.analyzers.failed],
  ['incomplete', (r) => r.stats?.completeness?.incomplete],
  ['incompleteness_reasons', (r) => r.stats?.completeness?.reasons],
  ['database_bytes', (r) => r.database?.databaseBytes],
  ['project_row_bytes', (r) => r.database?.projectRowBytes],
];

export const QUERY_CSV_COLUMNS: ReadonlyArray<[string, (record: QueryRecord) => unknown]> = [
  ['repository', (q) => q.repositoryId],
  ['kind', (q) => q.kind],
  ['key', (q) => q.key],
  ['round', (q) => q.round],
  ['warmup', (q) => q.warmup],
  ['iteration', (q) => q.iteration],
  ['at', (q) => q.at],
  ['status', (q) => q.status],
  ['ok', (q) => q.ok],
  ['client_ms', (q) => q.clientMs],
  ['server_ms', (q) => q.serverMs],
  ['result_count', (q) => q.resultCount],
  ['truncated', (q) => q.truncated],
  ['response_bytes', (q) => q.responseBytes],
  ['error', (q) => q.error],
];

export function toCsv<T>(rows: readonly T[], columns: ReadonlyArray<[string, (row: T) => unknown]>): string {
  const lines = [columns.map(([name]) => name).join(',')];
  for (const row of rows) lines.push(columns.map(([, read]) => csvCell(read(row))).join(','));
  return `${lines.join('\n')}\n`;
}

/** Empty for a missing value, `;`-joined for a list, quoted when it has to be. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join(';') : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sum(a: number | null | undefined, b: number | null | undefined): number | null {
  return typeof a === 'number' && typeof b === 'number' ? a + b : null;
}
