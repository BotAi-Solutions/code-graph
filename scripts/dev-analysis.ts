/**
 * `pnpm analyze:sample [repositoryPath] [projectName]`
 *
 * Runs the whole pipeline in one process, against a real database, without the
 * API or a long-running worker: create project -> attach repository -> queue an
 * analysis -> drain it -> print what landed in the graph.
 *
 * Handy for checking the analysis end of the system while working on the UI,
 * and for verifying a fresh checkout.
 */
import path from 'node:path';
import { createLogger } from '@ckg/shared/logger';
import { loadEnvFile } from '@ckg/shared/node';
import {
  databaseEnvSchema,
  graphProjection,
  parseEnv,
  runtimeEnvSchema,
  scipEnvSchema,
} from '@ckg/shared';
import {
  AnalysisJobRepository,
  GraphRepository,
  ProjectRepository,
  SourceRepositoryRepository,
  createDatabaseFromEnv,
  getMigrationStatus,
} from '@ckg/database';
import { LanguageDetectionService } from '@ckg/language-detection';
import { createDefaultIndexerRegistry } from '@ckg/scip';
import { AnalyzeRepositoryJob } from '../apps/worker/src/jobs/analyze-repository.job.js';
import { AnalysisWorkspace } from '../apps/worker/src/services/analysis-workspace.js';
import { RepositoryLoader } from '../apps/worker/src/services/repository-loader.js';

const DEFAULT_REPOSITORY = 'test-repositories/typescript-sample';

async function main(): Promise<void> {
  loadEnvFile();

  const repositoryPath = path.resolve(process.argv[2] ?? DEFAULT_REPOSITORY);
  const projectName = process.argv[3] ?? path.basename(repositoryPath);

  const env = parseEnv(runtimeEnvSchema.and(databaseEnvSchema).and(scipEnvSchema), process.env);
  const logger = createLogger({
    module: 'dev-analysis',
    level: env.LOG_LEVEL,
    base: { service: 'script' },
  });

  const database = createDatabaseFromEnv(
    { DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX },
    'ckg-dev-analysis',
  );

  try {
    const status = await getMigrationStatus(database);
    if (status.pending.length > 0) {
      throw new Error(
        `database has pending migrations (${status.pending.join(', ')}). Run: pnpm db:migrate`,
      );
    }

    const projects = new ProjectRepository(database);
    const repositories = new SourceRepositoryRepository(database);
    const analysisJobs = new AnalysisJobRepository(database);
    const graph = new GraphRepository(database);

    const project = await projects.create({
      name: projectName,
      description: `Created by scripts/dev-analysis.ts from ${repositoryPath}`,
    });
    process.stdout.write(`project   ${project.id}  ${project.name}\n`);

    const repository = await repositories.upsert({
      projectId: project.id,
      sourceType: 'local',
      sourcePath: repositoryPath,
      commitHash: null,
    });
    process.stdout.write(`repository ${repository.id}  ${repository.sourcePath}\n`);

    const queued = await analysisJobs.create({
      projectId: project.id,
      repositoryId: repository.id,
      language: null,
    });

    // Claim it the same way the worker does, so this script exercises the real
    // state machine rather than a shortcut.
    const claimed = await analysisJobs.claimNextQueued();
    if (!claimed || claimed.id !== queued.id) {
      throw new Error('another worker claimed the job first; stop it and retry');
    }

    const job = new AnalyzeRepositoryJob({
      analysisJobs,
      repositories,
      graph,
      languageDetection: new LanguageDetectionService(),
      indexers: createDefaultIndexerRegistry({
        typescriptCommand: env.SCIP_TYPESCRIPT_COMMAND,
        timeoutMs: env.SCIP_INDEX_TIMEOUT_MS,
        executableSearchRoots: [process.cwd()],
      }),
      repositoryLoader: new RepositoryLoader({ baseDirectory: process.cwd() }),
      workspace: new AnalysisWorkspace(path.resolve('.workspace')),
      logger,
      scipTimeoutMs: env.SCIP_INDEX_TIMEOUT_MS,
    });

    const stats = await job.run(claimed);

    process.stdout.write('\nanalysis completed\n');
    process.stdout.write(`  documents ${String(stats.documentCount)}\n`);
    process.stdout.write(`  symbols   ${String(stats.symbolCount)}\n`);
    process.stdout.write(`  nodes     ${String(stats.nodeCount)}\n`);
    process.stdout.write(`  edges     ${String(stats.edgeCount)}\n`);
    process.stdout.write(`  duration  ${String(stats.durationMs)}ms\n`);

    const composition = await graph.composition(project.id);
    process.stdout.write('\nnodes by type\n');
    for (const [type, count] of Object.entries(composition.nodeTypeCounts).sort(
      (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
    )) {
      process.stdout.write(`  ${type.padEnd(18)} ${String(count)}\n`);
    }

    // The architecture projection, which is what the UI opens on: the API
    // routes, services and data stores, ranked ahead of everything else.
    const architecture = graphProjection('architecture');
    const overview = await graph.overview(project.id, {
      nodeTypes: [...architecture.nodeTypes],
      relationships: [...architecture.relationships],
      priorityNodeTypes: [...architecture.priorityNodeTypes],
      limit: 18,
    });
    const names = new Map(
      overview.nodes.map((node) => [node.id, `${node.type}:${node.qualifiedName ?? node.name}`]),
    );

    process.stdout.write('\narchitecture\n');
    for (const edge of overview.edges.slice(0, 24)) {
      const confidence = String(edge.metadata?.confidence ?? '');
      process.stdout.write(
        `  ${(names.get(edge.sourceNodeId) ?? '?').padEnd(34)} -${edge.relationship}-> ${(
          names.get(edge.targetNodeId) ?? '?'
        ).padEnd(30)} ${confidence}\n`,
      );
    }

    process.stdout.write(`\nOpen the UI and select project ${project.id}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
