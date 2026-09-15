import type { AnalysisJob, AnalysisStats, AnalysisStatus, SupportedLanguage } from '@ckg/shared';
import type { Logger } from '@ckg/shared/logger';
import type {
  AnalysisJobRepository,
  GraphRepository,
  SourceRepositoryRepository,
} from '@ckg/database';
import { LanguageDetectionService } from '@ckg/language-detection';
import { readScipIndexFile, type ScipIndexerRegistry } from '@ckg/scip';
import { ScipGraphBuilder } from '@ckg/graph';
import { AnalysisWorkspace } from '../services/analysis-workspace.js';
import { RepositoryLoader } from '../services/repository-loader.js';

/**
 * The analysis pipeline.
 *
 *   load repository -> detect language -> select indexer -> run SCIP ->
 *   parse index.scip -> build graph -> persist nodes and edges -> complete
 *
 * Every dependency is injected, so the whole pipeline can be exercised with a
 * fake command runner and an in-memory database. Nothing here knows about HTTP,
 * and nothing here knows about a specific language: the registry decides which
 * indexer runs and which refiner post-processes its output.
 */

export interface AnalyzeRepositoryJobDependencies {
  analysisJobs: AnalysisJobRepository;
  repositories: SourceRepositoryRepository;
  graph: GraphRepository;
  languageDetection: LanguageDetectionService;
  indexers: ScipIndexerRegistry;
  repositoryLoader: RepositoryLoader;
  workspace: AnalysisWorkspace;
  logger: Logger;
  scipTimeoutMs: number;
}

export class AnalysisFailedError extends Error {
  constructor(message: string, readonly phase: AnalysisStatus) {
    super(message);
    this.name = 'AnalysisFailedError';
  }
}

export class AnalyzeRepositoryJob {
  constructor(private readonly deps: AnalyzeRepositoryJobDependencies) {}

  async run(job: AnalysisJob): Promise<AnalysisStats> {
    const startedAt = Date.now();
    const log = this.deps.logger.child({ jobId: job.id, projectId: job.projectId });

    const repository = await this.deps.repositories.findById(job.repositoryId);
    if (!repository) {
      throw new AnalysisFailedError(`repository ${job.repositoryId} no longer exists`, 'INDEXING');
    }

    const workspaceDirectory = await this.deps.workspace.prepare(job.id);
    const loaded = await this.deps.repositoryLoader.load(repository, workspaceDirectory);
    log.info({ repositoryName: loaded.name }, 'repository ready');

    // --- language -------------------------------------------------------
    const language = await this.resolveLanguage(job, loaded.path, log);
    await this.deps.analysisJobs.update(job.id, { language });

    const indexer = this.deps.indexers.resolve(language);
    if (!indexer) {
      throw new AnalysisFailedError(
        `no SCIP indexer is registered for ${language}`,
        'INDEXING',
      );
    }

    // --- index ----------------------------------------------------------
    log.info({ language, indexer: indexer.name }, 'running SCIP indexer');
    const indexResult = await indexer.index(loaded.path, {
      outputDirectory: workspaceDirectory,
      timeoutMs: this.deps.scipTimeoutMs,
    });
    log.info({ durationMs: indexResult.durationMs }, 'SCIP index produced');

    // --- parse ----------------------------------------------------------
    await this.setStatus(job.id, 'PARSING');
    const parsed = await readScipIndexFile(indexResult.indexPath);
    const refiner = this.deps.indexers.resolveRefiner(language);
    const index = await refiner.refine(parsed, { repositoryPath: loaded.path });

    const symbolCount = index.documents.reduce(
      (total, document) => total + document.symbols.length,
      0,
    );
    log.info({ documents: index.documents.length, symbols: symbolCount }, 'SCIP index parsed');

    // --- build ----------------------------------------------------------
    await this.setStatus(job.id, 'BUILDING_GRAPH');
    const builder = new ScipGraphBuilder({
      identity: { projectId: job.projectId, repositoryId: repository.id },
      repositoryName: loaded.name,
    });
    const graph = builder.build(index);
    log.info(
      { nodes: graph.stats.nodeCount, edges: graph.stats.edgeCount },
      'code knowledge graph built',
    );

    // --- persist --------------------------------------------------------
    await this.setStatus(job.id, 'PERSISTING');
    await this.deps.graph.replaceProjectGraph(job.projectId, graph);

    const stats: AnalysisStats = {
      documentCount: graph.stats.documentCount,
      symbolCount: graph.stats.symbolCount,
      nodeCount: graph.stats.nodeCount,
      edgeCount: graph.stats.edgeCount,
      durationMs: Date.now() - startedAt,
    };

    await this.deps.analysisJobs.update(job.id, {
      status: 'COMPLETED',
      completedAt: new Date(),
      error: null,
      stats,
    });

    // Successful runs clean up after themselves; failed ones keep their
    // artefacts so the index can be inspected.
    await this.deps.workspace.cleanup(job.id);

    log.info({ stats }, 'analysis completed');
    return stats;
  }

  private async resolveLanguage(
    job: AnalysisJob,
    repositoryPath: string,
    log: Logger,
  ): Promise<SupportedLanguage> {
    if (job.language) {
      log.info({ language: job.language }, 'language forced by request');
      return job.language;
    }

    const detection = await this.deps.languageDetection.detect(repositoryPath);
    if (!detection.primaryLanguage) {
      throw new AnalysisFailedError(
        'no supported language was detected in the repository',
        'INDEXING',
      );
    }

    const supported = this.deps.indexers.supportedLanguages(detection.languages);
    const language = supported[0] ?? detection.primaryLanguage;

    log.info(
      { detected: detection.languages, selected: language, markers: detection.evidence[0]?.markers },
      'language detected',
    );
    return language;
  }

  private async setStatus(jobId: string, status: AnalysisStatus): Promise<void> {
    await this.deps.analysisJobs.setStatus(jobId, status);
  }
}
