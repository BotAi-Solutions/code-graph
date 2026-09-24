import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AnalysisJob,
  AnalysisProgress,
  AnalysisStats,
  CodeGraph,
  Repository,
  SourceRevision,
} from '@ckg/shared';
import { createSilentLogger } from '@ckg/shared/logger';
import { findWorkspaceRoot } from '@ckg/shared/node';
import { LanguageDetectionService } from '@ckg/language-detection';
import {
  ScipIndexerRegistry,
  TypeScriptScipIndexer,
  TypeScriptSymbolRefiner,
  type CommandResult,
  type CommandRunner,
  type RunOptions,
} from '@ckg/scip';
import type { CodeAnalyzer } from '@ckg/graph';
import { AnalyzeRepositoryJob } from '../src/jobs/analyze-repository.job.js';
import { AnalysisProcessor } from '../src/processors/analysis.processor.js';
import { AnalysisWorkspace } from '../src/services/analysis-workspace.js';
import { RepositoryLoader } from '../src/services/repository-loader.js';

/**
 * The analysis pipeline end to end, with the one genuinely external piece — the
 * SCIP indexer subprocess — replaced by a runner that drops the checked-in
 * fixture where the indexer would have written it. Everything after that point
 * is the real parser, the real refiner, the real builder.
 */

const FIXTURE = fileURLToPath(
  new URL('../../../packages/scip/tests/fixtures/typescript-sample.scip', import.meta.url),
);
const SAMPLE_REPOSITORY = path.resolve(
  fileURLToPath(new URL('../../../test-repositories/typescript-sample', import.meta.url)),
);

/** The layered service that exercises the architectural analyzers. */
const SERVICE_FIXTURE = fileURLToPath(
  new URL('../../../packages/scip/tests/fixtures/express-postgres-sample.scip', import.meta.url),
);
const SERVICE_REPOSITORY = path.resolve(
  fileURLToPath(new URL('../../../test-repositories/express-postgres-sample', import.meta.url)),
);

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const REPOSITORY_ID = '44444444-4444-4444-8444-444444444444';

class FixtureCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  constructor(private readonly fixture: string = FIXTURE) {}

  async run(command: string, args: string[], _options: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args });

    const outputIndex = args.indexOf('--output');
    if (outputIndex >= 0) {
      await copyFile(this.fixture, args[outputIndex + 1] as string);
    }

    return {
      exitCode: 0,
      signal: null,
      stdout: '+ test-repositories/typescript-sample (30ms)\n',
      stderr: '',
      timedOut: false,
      durationMs: 30,
    };
  }
}

class FailingCommandRunner implements CommandRunner {
  async run(): Promise<CommandResult> {
    return {
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'tsconfig.json not found',
      timedOut: false,
      durationMs: 5,
    };
  }
}

class FakeAnalysisJobRepository {
  readonly jobs = new Map<string, AnalysisJob>();
  readonly statusHistory: string[] = [];
  /** Every position the pipeline published, in order. */
  readonly progressHistory: AnalysisProgress[] = [];

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
    if (typeof patch.status === 'string') this.statusHistory.push(patch.status);
    return next;
  }

  async setStatus(id: string, status: AnalysisJob['status']): Promise<void> {
    await this.update(id, { status });
  }

  async setProgress(id: string, progress: AnalysisProgress): Promise<void> {
    this.progressHistory.push(progress);
    await this.update(id, { progress });
  }
}

class FakeRepositoryStore {
  constructor(private readonly repository: Repository) {}

  async findById(id: string): Promise<Repository | null> {
    return id === this.repository.id ? this.repository : null;
  }
}

class FakeGraphRepository {
  graph: CodeGraph = { nodes: [], edges: [] };
  replaceCount = 0;

  async replaceProjectGraph(_projectId: string, graph: CodeGraph) {
    this.graph = graph;
    this.replaceCount += 1;
    return { nodeCount: graph.nodes.length, edgeCount: graph.edges.length };
  }
}

function queuedJob(): AnalysisJob {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    projectId: PROJECT_ID,
    repositoryId: REPOSITORY_ID,
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
  };
}

const LOCAL_REPOSITORY: Repository = {
  id: REPOSITORY_ID,
  projectId: PROJECT_ID,
  sourceType: 'local',
  sourcePath: SAMPLE_REPOSITORY,
  commitHash: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** The order the pipeline must publish phases in. */
const ORDERED_PHASES = [
  'queued',
  'scanning',
  'indexing',
  'parsing',
  'resolving',
  'building_graph',
  'persisting',
  'completed',
] as string[];

describe('AnalyzeRepositoryJob', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ckg-worker-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function createJob(
    commandRunner: CommandRunner,
    repository: Repository = LOCAL_REPOSITORY,
    options: {
      analyzers?: CodeAnalyzer[];
      captureRevision?: (directory: string) => Promise<SourceRevision>;
    } = {},
  ): {
    job: AnalyzeRepositoryJob;
    analysisJobs: FakeAnalysisJobRepository;
    graph: FakeGraphRepository;
  } {
    const analysisJobs = new FakeAnalysisJobRepository();
    const graph = new FakeGraphRepository();

    const indexers = new ScipIndexerRegistry()
      .register(new TypeScriptScipIndexer({ commandRunner, command: '/bin/scip-typescript' }))
      .registerRefiner(new TypeScriptSymbolRefiner());

    const job = new AnalyzeRepositoryJob({
      analysisJobs: analysisJobs as never,
      repositories: new FakeRepositoryStore(repository) as never,
      graph: graph as never,
      languageDetection: new LanguageDetectionService(),
      indexers,
      repositoryLoader: new RepositoryLoader({ baseDirectory: findWorkspaceRoot() }),
      workspace: new AnalysisWorkspace(workspaceRoot),
      logger: createSilentLogger(),
      scipTimeoutMs: 1000,
      ...(options.analyzers ? { analyzers: options.analyzers } : {}),
      ...(options.captureRevision ? { captureRevision: options.captureRevision } : {}),
    });

    return { job, analysisJobs, graph };
  }

  it('runs the whole pipeline and persists a graph', async () => {
    const { job, analysisJobs, graph } = createJob(new FixtureCommandRunner());
    const queued = analysisJobs.seed(queuedJob());

    const stats: AnalysisStats = await job.run(queued);

    expect(stats.documentCount).toBe(6);
    expect(stats.nodeCount).toBeGreaterThan(50);
    expect(stats.edgeCount).toBeGreaterThan(100);
    expect(graph.replaceCount).toBe(1);
    expect(graph.graph.nodes.length).toBe(stats.nodeCount);
  });

  it('produces exactly the SCIP graph when no analyzer is registered', async () => {
    const withAnalyzers = createJob(new FixtureCommandRunner());
    await withAnalyzers.job.run(withAnalyzers.analysisJobs.seed(queuedJob()));

    const scipOnly = createJob(new FixtureCommandRunner(), LOCAL_REPOSITORY, { analyzers: [] });
    await scipOnly.job.run(scipOnly.analysisJobs.seed(queuedJob()));

    // The analyzers only ever add: every node the SCIP-only run produced is
    // still there, with the same identity.
    const scipIds = new Set(scipOnly.graph.graph.nodes.map((node) => node.id));
    const enrichedIds = new Set(withAnalyzers.graph.graph.nodes.map((node) => node.id));

    for (const id of scipIds) expect(enrichedIds.has(id)).toBe(true);
    expect(enrichedIds.size).toBeGreaterThan(scipIds.size);
    expect(
      scipOnly.graph.graph.nodes.some((node) => node.type === 'service' || node.type === 'config'),
    ).toBe(false);
  });

  it('moves through the documented job states in order', async () => {
    const { job, analysisJobs } = createJob(new FixtureCommandRunner());
    const queued = analysisJobs.seed(queuedJob());

    await job.run(queued);

    expect(analysisJobs.statusHistory).toEqual([
      'PARSING',
      'BUILDING_GRAPH',
      'PERSISTING',
      'COMPLETED',
    ]);
  });

  it('reports real progress through every phase, in order', async () => {
    const { job, analysisJobs } = createJob(new FixtureCommandRunner());
    await job.run(analysisJobs.seed(queuedJob()));

    const phases = analysisJobs.progressHistory.map((entry) => entry.phase);

    // Each phase appears, and no phase comes back after a later one started.
    for (const phase of ['scanning', 'indexing', 'parsing', 'resolving', 'building_graph', 'persisting', 'completed']) {
      expect(phases).toContain(phase);
    }
    expect([...phases]).toEqual(
      [...phases].sort(
        (a, b) => ORDERED_PHASES.indexOf(a) - ORDERED_PHASES.indexOf(b),
      ),
    );

    // Where a phase claims a denominator it is a real one, and the position
    // never exceeds it.
    for (const entry of analysisJobs.progressHistory) {
      expect(entry.current).toBeGreaterThanOrEqual(0);
      if (entry.total > 0) expect(entry.current).toBeLessThanOrEqual(entry.total);
      expect(entry.message.length).toBeGreaterThan(0);
    }

    const resolving = analysisJobs.progressHistory.filter((e) => e.phase === 'resolving');
    expect(resolving.at(-1)?.current).toBe(resolving.at(-1)?.total);
  });

  it('records what it actually counted in the job statistics', async () => {
    const { job, analysisJobs, graph } = createJob(new FixtureCommandRunner());
    const stats = await job.run(analysisJobs.seed(queuedJob()));

    const countOf = (type: string): number =>
      graph.graph.nodes.filter((node) => node.type === type).length;

    // Symbol counts come from the graph.
    expect(stats.classCount).toBe(countOf('class'));
    expect(stats.interfaceCount).toBe(countOf('interface'));
    expect(stats.functionCount).toBe(countOf('function') + countOf('method'));
    expect(stats.edgeCount).toBe(graph.graph.edges.length);

    // Files and directories come from the scan, so both describe the folder
    // that was chosen rather than whatever the indexer reached.
    expect(stats.sourceFileCount).toBeGreaterThan(0);
    expect(stats.fileCount).toBeGreaterThanOrEqual(stats.sourceFileCount as number);
    expect(stats.directoryCount).toBeGreaterThan(0);
    expect(stats.languages?.typescript).toBeGreaterThan(0);
    expect(stats.parseErrorCount).toBe(0);
  });

  it('completes the run when one analyzer throws, and says which', async () => {
    class ExplodingAnalyzer implements CodeAnalyzer {
      readonly name = 'exploding-analyzer';
      readonly stage = 'source' as const;
      supports(): boolean {
        return true;
      }
      async analyze(): Promise<never> {
        throw new Error('this analyzer is broken');
      }
    }

    const { job, analysisJobs, graph } = createJob(new FixtureCommandRunner(), LOCAL_REPOSITORY, {
      analyzers: [new ExplodingAnalyzer()],
    });

    const stats = await job.run(analysisJobs.seed(queuedJob()));

    // The SCIP graph is still built and still persisted.
    expect(stats.nodeCount).toBeGreaterThan(50);
    expect(graph.replaceCount).toBe(1);
    expect(analysisJobs.jobs.get('55555555-5555-4555-8555-555555555555')?.status).toBe('COMPLETED');
  });

  it('detects the language and records it on the job', async () => {
    const { job, analysisJobs } = createJob(new FixtureCommandRunner());
    const queued = analysisJobs.seed(queuedJob());

    await job.run(queued);

    expect(analysisJobs.jobs.get(queued.id)?.language).toBe('typescript');
  });

  it('produces the architectural chain the sample repository describes', async () => {
    const { job, analysisJobs, graph } = createJob(new FixtureCommandRunner());
    await job.run(analysisJobs.seed(queuedJob()));

    const node = (name: string, type: string) =>
      graph.graph.nodes.find((item) => item.name === name && item.type === type);

    const linked = (from: string, fromType: string, relationship: string, to: string, toType: string) =>
      graph.graph.edges.some(
        (edge) =>
          edge.sourceNodeId === node(from, fromType)?.id &&
          edge.targetNodeId === node(to, toType)?.id &&
          edge.relationship === relationship,
      );

    expect(linked('UserController', 'class', 'CALLS', 'UserService', 'class')).toBe(true);
    expect(linked('UserService', 'class', 'CALLS', 'UserRepository', 'class')).toBe(true);
    expect(linked('UserRepository', 'class', 'REFERENCES', 'User', 'interface')).toBe(true);
  });

  it('is idempotent: a second run reproduces the same node ids', async () => {
    const first = createJob(new FixtureCommandRunner());
    await first.job.run(first.analysisJobs.seed(queuedJob()));

    const second = createJob(new FixtureCommandRunner());
    await second.job.run(second.analysisJobs.seed(queuedJob()));

    expect(second.graph.graph.nodes.map((node) => node.id)).toEqual(
      first.graph.graph.nodes.map((node) => node.id),
    );
    expect(second.graph.graph.edges.map((edge) => edge.id)).toEqual(
      first.graph.graph.edges.map((edge) => edge.id),
    );
  });

  it('fails the job when the indexer fails, without persisting a graph', async () => {
    const { job, analysisJobs, graph } = createJob(new FailingCommandRunner());
    const queued = analysisJobs.seed(queuedJob());

    await expect(job.run(queued)).rejects.toThrow(/exited with code 1/);
    expect(graph.replaceCount).toBe(0);
  });

  it('records what it indexed from on the completed run, for the freshness check', async () => {
    const revision: SourceRevision = {
      vcs: 'git',
      commit: 'abc123abc123abc123abc123abc123abc123abcd',
      changes: {},
      changeCount: 0,
      digest: 'd',
      capturedAt: '2026-01-01T00:00:00.000Z',
    };
    const captured: string[] = [];
    const { job, analysisJobs } = createJob(new FixtureCommandRunner(), LOCAL_REPOSITORY, {
      captureRevision: async (directory) => {
        captured.push(directory);
        return revision;
      },
    });
    const queued = analysisJobs.seed(queuedJob());

    await job.run(queued);

    expect(captured).toHaveLength(1);
    expect(path.isAbsolute(captured[0] ?? '')).toBe(true);
    expect(analysisJobs.jobs.get(queued.id)).toMatchObject({
      status: 'COMPLETED',
      sourceRevision: revision,
    });
  });

  it('completes with an unknown revision when it cannot be captured', async () => {
    const { job, analysisJobs } = createJob(new FixtureCommandRunner(), LOCAL_REPOSITORY, {
      captureRevision: async () => {
        throw new Error('git exploded');
      },
    });
    const queued = analysisJobs.seed(queuedJob());

    await job.run(queued);

    expect(analysisJobs.jobs.get(queued.id)).toMatchObject({
      status: 'COMPLETED',
      sourceRevision: null,
    });
  });

  it('resolves a relative repository path the way the UI sends it', async () => {
    // The UI's default is `test-repositories/typescript-sample`, relative to the
    // monorepo root — not to the worker's own working directory, which is
    // `apps/worker` under `pnpm dev`.
    const { job, analysisJobs, graph } = createJob(new FixtureCommandRunner(), {
      ...LOCAL_REPOSITORY,
      sourcePath: 'test-repositories/typescript-sample',
    });

    await job.run(analysisJobs.seed(queuedJob()));

    expect(graph.graph.nodes.length).toBeGreaterThan(50);
  });

  it('names the resolved path when the repository is missing', async () => {
    const { job, analysisJobs } = createJob(new FixtureCommandRunner(), {
      ...LOCAL_REPOSITORY,
      sourcePath: 'does/not/exist',
    });

    await expect(job.run(analysisJobs.seed(queuedJob()))).rejects.toThrow(
      /does not exist: does\/not\/exist \(resolved to \//,
    );
  });

  it('fails clearly when the repository path does not exist', async () => {
    const { job, analysisJobs } = createJob(new FixtureCommandRunner(), {
      ...LOCAL_REPOSITORY,
      sourcePath: '/nonexistent/repository',
    });

    await expect(job.run(analysisJobs.seed(queuedJob()))).rejects.toThrow(/does not exist/);
  });

  describe('over a layered service repository', () => {
    const SERVICE: Repository = {
      ...LOCAL_REPOSITORY,
      sourcePath: SERVICE_REPOSITORY,
    };

    async function analyse(): Promise<FakeGraphRepository> {
      const { job, analysisJobs, graph } = createJob(
        new FixtureCommandRunner(SERVICE_FIXTURE),
        SERVICE,
      );
      await job.run(analysisJobs.seed(queuedJob()));
      return graph;
    }

    it('persists the architectural layer alongside the symbol graph', async () => {
      const graph = await analyse();

      const byType = (type: string): string[] =>
        graph.graph.nodes.filter((node) => node.type === type).map((node) => node.name);

      expect(byType('api')).toContain('POST /users');
      expect(byType('table')).toContain('users');
      expect(byType('queue')).toContain('welcome-emails');
      expect(byType('event')).toContain('user.created');
      expect(byType('external_service').sort()).toEqual(['SendGrid', 'Stripe']);
      expect(byType('service')).toEqual(['users-service']);
      // And the symbols SCIP found are all still there.
      expect(byType('class')).toContain('UserService');
    });

    it('produces the request-to-store chain the sample documents', async () => {
      const graph = await analyse();

      const node = (type: string, name: string) =>
        graph.graph.nodes.find(
          (item) => item.type === type && (item.name === name || item.qualifiedName === name),
        );

      const linked = (from: string, fromType: string, relationship: string, to: string, toType: string) =>
        graph.graph.edges.some(
          (edge) =>
            edge.sourceNodeId === node(fromType, from)?.id &&
            edge.targetNodeId === node(toType, to)?.id &&
            edge.relationship === relationship,
        );

      expect(linked('POST /users', 'api', 'ROUTES_TO', 'UserController.create', 'method')).toBe(true);
      expect(linked('UserController.create', 'method', 'CALLS', 'UserService.create', 'method')).toBe(true);
      expect(linked('UserService.create', 'method', 'CALLS', 'UserRepository.create', 'method')).toBe(true);
      expect(linked('UserRepository.create', 'method', 'WRITES_TO', 'users', 'table')).toBe(true);
      expect(linked('EmailService', 'class', 'CALLS', 'SendGrid', 'external_service')).toBe(true);
      expect(linked('UserService.create', 'method', 'PUBLISHES', 'user.created', 'event')).toBe(true);
    });

    it('is idempotent across the whole pipeline, analyzers included', async () => {
      const first = await analyse();
      const second = await analyse();

      expect(second.graph.nodes.map((node) => node.id)).toEqual(
        first.graph.nodes.map((node) => node.id),
      );
      expect(second.graph.edges.map((edge) => edge.id)).toEqual(
        first.graph.edges.map((edge) => edge.id),
      );
    });
  });
});

describe('AnalysisProcessor', () => {
  it('records a failure on the job instead of crashing the worker', async () => {
    const analysisJobs = new FakeAnalysisJobRepository();
    const queued = analysisJobs.seed(queuedJob());
    let claimed = false;

    const processor = new AnalysisProcessor({
      queue: {
        claim: async () => {
          if (claimed) return null;
          claimed = true;
          return queued;
        },
      },
      job: {
        run: () => Promise.reject(new Error('SCIP exploded')),
      } as never,
      analysisJobs: analysisJobs as never,
      logger: createSilentLogger(),
      pollIntervalMs: 1,
    });

    await expect(processor.tick()).resolves.toBe(true);

    expect(analysisJobs.jobs.get(queued.id)).toMatchObject({
      status: 'FAILED',
      error: 'SCIP exploded',
    });
  });

  it('reports an idle queue rather than spinning', async () => {
    const processor = new AnalysisProcessor({
      queue: { claim: async () => null },
      job: { run: () => Promise.reject(new Error('never')) } as never,
      analysisJobs: new FakeAnalysisJobRepository() as never,
      logger: createSilentLogger(),
      pollIntervalMs: 1,
    });

    await expect(processor.tick()).resolves.toBe(false);
  });
});
