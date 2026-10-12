/**
 * One indexing run of the performance benchmark, in a process of its own.
 *
 *   tsx scripts/perf-index-once.ts <spec.json>
 *
 * Started by `scripts/perf-benchmark.ts`, never by hand. Every run gets a
 * fresh process so that its peak memory is its own (a process's peak RSS can
 * only rise) and no JIT or in-memory module state carries over from the run
 * before. tsx's on-disk transform cache does persist between runs; it affects
 * process start-up, which `harnessWallMs` includes and the job's own timings
 * do not.
 *
 * Runs the real `AnalyzeRepositoryJob` — the production pipeline — with one
 * substitution: the SCIP indexer is started through `MeasuringCommandRunner`,
 * so its CPU and memory are measured too. The result, including a failure,
 * is written to the spec's `outFile` as JSON; the exit code only says whether
 * this script itself worked.
 *
 * The database connection string arrives in `BENCHMARK_DATABASE_URL`, never on
 * the command line, where `ps` would show it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AnalysisJob,
  AnalysisProgress,
  AnalysisStats,
  CodeGraph,
  Repository,
} from '@ckg/shared';
import { createSilentLogger } from '@ckg/shared/logger';
import {
  AnalysisJobRepository,
  GraphRepository,
  SourceRepositoryRepository,
  createDatabase,
} from '@ckg/database';
import { LanguageDetectionService } from '@ckg/language-detection';
import {
  MeasuringCommandRunner,
  ScipIndexerRegistry,
  TypeScriptScipIndexer,
  TypeScriptSymbolRefiner,
} from '@ckg/scip';
import type { IndexRunOutput, ScipMeasurement } from '@ckg/benchmark';
import { AnalyzeRepositoryJob } from '../apps/worker/src/jobs/analyze-repository.job.js';
import { AnalysisWorkspace } from '../apps/worker/src/services/analysis-workspace.js';
import { RepositoryLoader } from '../apps/worker/src/services/repository-loader.js';

export interface IndexRunSpec {
  repositoryPath: string;
  /** The benchmark project. Required for `postgres`; generated for `in-memory`. */
  projectId: string | null;
  store: 'postgres' | 'in-memory';
  workspaceDirectory: string;
  scipCommand: string;
  scipTimeoutMs: number;
  /** Roots searched for a locally installed scip-typescript. */
  executableSearchRoots: string[];
  outFile: string;
}

async function main(): Promise<void> {
  const specFile = process.argv[2];
  if (!specFile) throw new Error('usage: perf-index-once <spec.json>');
  const spec = JSON.parse(await readFile(specFile, 'utf8')) as IndexRunSpec;

  const runner = new MeasuringCommandRunner();
  const indexers = new ScipIndexerRegistry()
    .register(
      new TypeScriptScipIndexer({
        command: spec.scipCommand,
        commandRunner: runner,
        defaultTimeoutMs: spec.scipTimeoutMs,
        executableSearchRoots: spec.executableSearchRoots,
      }),
    )
    .registerRefiner(new TypeScriptSymbolRefiner());

  const output = spec.store === 'postgres' ? await runAgainstPostgres(spec, indexers, runner) : await runInMemory(spec, indexers, runner);
  await writeFile(spec.outFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

type Stores = {
  analysisJobs: AnalysisJobRepository | InMemoryJobs;
  repositories: SourceRepositoryRepository | InMemoryRepositories;
  graph: GraphRepository | InMemoryGraph;
};

async function runAgainstPostgres(
  spec: IndexRunSpec,
  indexers: ScipIndexerRegistry,
  runner: MeasuringCommandRunner,
): Promise<IndexRunOutput> {
  const url = process.env.BENCHMARK_DATABASE_URL;
  if (!url) throw new Error('BENCHMARK_DATABASE_URL is not set');
  if (!spec.projectId) throw new Error('a postgres run needs a projectId');

  const database = createDatabase({ connectionString: url, maxConnections: 4, applicationName: 'ckg-perf-run' });
  try {
    const repositories = new SourceRepositoryRepository(database);
    const analysisJobs = new AnalysisJobRepository(database);
    const graph = new GraphRepository(database);

    const repository = await repositories.upsert({
      projectId: spec.projectId,
      sourceType: 'local',
      sourcePath: spec.repositoryPath,
      commitHash: null,
    });
    const queued = await analysisJobs.create({ projectId: spec.projectId, repositoryId: repository.id, language: null });
    // Claimed by its own id, with the same state change the worker's claim
    // makes (QUEUED -> INDEXING, started_at). Never the oldest queued job of
    // some other project: on a database with anything else queued, that would
    // take a job that is not ours and leave it stuck.
    const claim = await database.query<{ id: string }>(
      `UPDATE analysis_jobs SET status = 'INDEXING', started_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'QUEUED' RETURNING id`,
      [queued.id],
    );
    const claimed = claim.rows.length === 1 ? await analysisJobs.findById(queued.id) : null;
    if (!claimed) {
      throw new Error('the benchmark job was claimed by something else; the benchmark database must not have a worker attached');
    }

    const result = await runJob(claimed, spec, indexers, runner, { analysisJobs, repositories, graph });
    const stored = await analysisJobs.findById(claimed.id);
    return { ...result, jobStatus: stored?.status ?? result.jobStatus };
  } finally {
    await database.close();
  }
}

async function runInMemory(
  spec: IndexRunSpec,
  indexers: ScipIndexerRegistry,
  runner: MeasuringCommandRunner,
): Promise<IndexRunOutput> {
  const projectId = spec.projectId ?? '00000000-0000-4000-8000-0000000000aa';
  const repository: Repository = {
    id: '00000000-0000-4000-8000-0000000000ab',
    projectId,
    sourceType: 'local',
    sourcePath: spec.repositoryPath,
    commitHash: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Repository;
  const analysisJobs = new InMemoryJobs();
  const job = analysisJobs.seed({
    id: '00000000-0000-4000-8000-0000000000ac',
    projectId,
    repositoryId: repository.id,
    status: 'INDEXING',
    language: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    stats: null,
    progress: null,
    errors: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as AnalysisJob);

  const result = await runJob(job, spec, indexers, runner, {
    analysisJobs,
    repositories: new InMemoryRepositories(repository),
    graph: new InMemoryGraph(),
  });
  return { ...result, persistence: 'in-memory' };
}

async function runJob(
  claimed: AnalysisJob,
  spec: IndexRunSpec,
  indexers: ScipIndexerRegistry,
  runner: MeasuringCommandRunner,
  stores: Stores,
): Promise<IndexRunOutput> {
  const job = new AnalyzeRepositoryJob({
    analysisJobs: stores.analysisJobs as AnalysisJobRepository,
    repositories: stores.repositories as SourceRepositoryRepository,
    graph: stores.graph as GraphRepository,
    languageDetection: new LanguageDetectionService(),
    indexers,
    repositoryLoader: new RepositoryLoader({ baseDirectory: path.dirname(spec.repositoryPath) }),
    workspace: new AnalysisWorkspace(spec.workspaceDirectory),
    logger: createSilentLogger(),
    scipTimeoutMs: spec.scipTimeoutMs,
  });

  let stats: AnalysisStats | null = null;
  let error: string | null = null;
  try {
    stats = await job.run(claimed);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    // The indexer's own last words say why, where "exited with code 1" does not.
    const diagnostics = (caught as { details?: { diagnostics?: string[] } }).details?.diagnostics ?? [];
    const reason = diagnostics.filter((line) => /error/i.test(line)).slice(-2);
    if (reason.length > 0) error = `${error}: ${reason.join(' | ')}`;
    // What the worker's processor would do: the job is FAILED, with a reason.
    await stores.analysisJobs.update(claimed.id, { status: 'FAILED', error, completedAt: new Date() });
  }

  return {
    outcome: stats ? 'completed' : 'failed',
    error,
    jobId: claimed.id,
    jobStatus: stats ? 'COMPLETED' : 'FAILED',
    stats,
    scip: scipMeasurement(runner, spec),
    persistence: spec.store,
  };
}

function scipMeasurement(runner: MeasuringCommandRunner, spec: IndexRunSpec): ScipMeasurement | null {
  const last = runner.last;
  if (!last) return null;
  return {
    command: spec.scipCommand,
    args: ['index', '--cwd', spec.repositoryPath, '--output', '<workspace>/index.scip', '--infer-tsconfig', '--no-progress-bar'],
    exitCode: last.exitCode,
    signal: last.signal,
    timedOut: last.timedOut,
    wallMs: last.durationMs,
    userCpuMs: last.resourceUsage?.userCpuMs ?? null,
    systemCpuMs: last.resourceUsage?.systemCpuMs ?? null,
    peakRssBytes: last.resourceUsage?.peakRssBytes ?? null,
    method: last.resourceUsage?.method ?? null,
    measurementError: last.measurementError ?? null,
  };
}

// --- in-memory stores, for a smoke run without a database -----------------

class InMemoryJobs {
  private readonly jobs = new Map<string, AnalysisJob>();
  seed(job: AnalysisJob): AnalysisJob {
    this.jobs.set(job.id, job);
    return job;
  }
  async findById(id: string): Promise<AnalysisJob | null> {
    return this.jobs.get(id) ?? null;
  }
  async update(id: string, patch: Record<string, unknown>): Promise<AnalysisJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const next = { ...job, ...patch } as AnalysisJob;
    this.jobs.set(id, next);
    return next;
  }
  async setStatus(id: string, status: AnalysisJob['status']): Promise<void> {
    await this.update(id, { status });
  }
  async setProgress(id: string, progress: AnalysisProgress): Promise<void> {
    await this.update(id, { progress });
  }
}

class InMemoryRepositories {
  constructor(private readonly repository: Repository) {}
  async findById(id: string): Promise<Repository | null> {
    return id === this.repository.id ? this.repository : null;
  }
}

class InMemoryGraph {
  private graph: CodeGraph = { nodes: [], edges: [] };
  async replaceProjectGraph(_projectId: string, graph: CodeGraph) {
    this.graph = graph;
    return { nodeCount: this.graph.nodes.length, edgeCount: this.graph.edges.length };
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
