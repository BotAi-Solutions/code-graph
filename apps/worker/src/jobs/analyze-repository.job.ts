import type {
  AnalysisCompleteness,
  AnalysisJob,
  AnalysisStats,
  IncompletenessReason,
  AnalysisStatus,
  CodeNodeType,
  IndexingError,
  ProjectMetadata,
  SourceRevision,
  SupportedLanguage,
} from '@ckg/shared';
import type { Logger } from '@ckg/shared/logger';
import type {
  AnalysisJobRepository,
  GraphRepository,
  SourceRepositoryRepository,
} from '@ckg/database';
import {
  LanguageDetectionService,
  ProjectScanError,
  captureSourceRevision,
  scanProject,
  type RepositoryScan,
} from '@ckg/language-detection';
import { readScipIndexFile, type ScipIndexerRegistry } from '@ckg/scip';
import {
  CodeGraphAssembler,
  ScipAnalyzer,
  type AssembledGraph,
  type CodeAnalyzer,
} from '@ckg/graph';
import { createDefaultAnalyzers, loadSourceFiles, type InMemorySourceFileSet } from '@ckg/analysis';
import { AnalysisWorkspace } from '../services/analysis-workspace.js';
import { AnalysisProgressReporter } from '../services/progress-reporter.js';
import { RepositoryLoader } from '../services/repository-loader.js';
import { RunMetrics } from '../services/run-metrics.js';

/**
 * The analysis pipeline.
 *
 *   load repository -> scan and classify -> detect language -> select indexer ->
 *   run SCIP -> parse index.scip -> read source -> build graph -> run the
 *   source analyzers -> run the classifiers -> merge -> persist -> complete
 *
 * SCIP remains the code-intelligence stage and the authority on symbols. The
 * source analyzers add the architectural layer — routes, data stores,
 * integrations, queues — and the repository layer: documents, configuration,
 * API specifications and the database schema. The classification stage then
 * reasons about the whole graph, which is where a cross-source relationship can
 * be made at all: an operation can only be linked to its handler once both the
 * specification and the route are in the graph.
 *
 * Every one of them enters through the same `CodeAnalyzer` seam, so the phases
 * below did not change when the repository layer was added — the *source* phase
 * simply has more analyzers in it, and `resolving` reports the real count.
 * `CodeGraphAssembler` owns the merge.
 *
 * The scan at the front does two jobs. It establishes what is in the project —
 * how many files, in which languages — which is what the statistics panel is
 * made of and what the language detector reads anyway. And it gives every later
 * phase a denominator, which is what separates a progress bar that means
 * something from one that moves because time is passing.
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
  /**
   * Source analyzers to run after SCIP. Defaults to the standard set; a test
   * or a future configuration can pass a narrower one, and passing `[]` gives
   * exactly the SCIP-only graph this pipeline produced before they existed.
   */
  analyzers?: readonly CodeAnalyzer[] | undefined;
  /**
   * Fingerprints the working tree before the run reads it, so a later
   * freshness check can say whether the stored graph still matches the files.
   * Defaults to the real one; a test can pass a stub.
   */
  captureRevision?: ((directory: string) => Promise<SourceRevision>) | undefined;
  /**
   * Overrides the source read's limits (file count, bytes per file, total
   * bytes). Defaults to the loader's own. A test sets them low to make a
   * truncated run happen; a benchmark can record which it used.
   */
  sourceReadLimits?:
    | { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number }
    | undefined;
}

export class AnalysisFailedError extends Error {
  constructor(message: string, readonly phase: AnalysisStatus) {
    super(message);
    this.name = 'AnalysisFailedError';
  }
}

/**
 * Node types the statistics panel reports, mapped to their stat field.
 *
 * Symbol counts only. Files and directories come from the scan instead, so that
 * every figure under "Project statistics" describes the folder that was chosen:
 * an indexer following project references can put files from a sibling package
 * in the graph, and "34 files, 42 directories" side by side would be two
 * different questions answered under one heading.
 */
const COUNTED_NODE_TYPES: ReadonlyArray<[CodeNodeType, 'classCount' | 'interfaceCount']> = [
  ['class', 'classCount'],
  ['interface', 'interfaceCount'],
];

export class AnalyzeRepositoryJob {
  constructor(private readonly deps: AnalyzeRepositoryJobDependencies) {}

  async run(job: AnalysisJob): Promise<AnalysisStats> {
    const startedAt = Date.now();
    const metrics = new RunMetrics();
    const log = this.deps.logger.child({ jobId: job.id, projectId: job.projectId });

    const progress = new AnalysisProgressReporter({
      jobId: job.id,
      sink: this.deps.analysisJobs,
      logger: log,
    });

    const repository = await this.deps.repositories.findById(job.repositoryId);
    if (!repository) {
      throw new AnalysisFailedError(`repository ${job.repositoryId} no longer exists`, 'INDEXING');
    }

    const workspaceDirectory = await this.deps.workspace.prepare(job.id);
    const loaded = await metrics.time('repositoryLoad', () =>
      this.deps.repositoryLoader.load(repository, workspaceDirectory),
    );
    log.info({ repositoryName: loaded.name }, 'repository ready');

    // Before the scan reads anything: a file saved mid-run is then newer than
    // the capture, and the finished graph reads as stale rather than current.
    const sourceRevision = await metrics.time('sourceRevision', () =>
      this.captureRevision(loaded.path, log),
    );

    // --- scan -----------------------------------------------------------
    // One walk of the tree, shared by language detection, the source loader
    // and the statistics. A second walk would be the same answer, slower.
    progress.report({
      phase: 'scanning',
      current: 0,
      total: 0,
      message: 'Scanning project files…',
    });

    const scanned = await metrics.time('scan', () =>
      this.scan(loaded.path, (filesSeen) => {
        progress.report({
          phase: 'scanning',
          current: filesSeen,
          // A walk does not know how many files it will find until it has found
          // them, so there is no denominator to offer and none is invented.
          total: 0,
          message: `Scanning project files… ${String(filesSeen)} found`,
        });
      }),
    );

    const metadata = scanned.metadata;
    progress.carry({ files: metadata.sourceFiles });
    log.info(
      {
        files: metadata.totalFiles,
        sourceFiles: metadata.sourceFiles,
        directories: metadata.directories,
        languages: metadata.languages,
        fileCategories: metadata.fileCategories,
      },
      'project scanned',
    );

    // --- language -------------------------------------------------------
    const language = await metrics.time('languageDetection', () =>
      this.resolveLanguage(job, scanned.scan, log),
    );
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
    progress.report({
      phase: 'indexing',
      current: 0,
      // The indexer is one subprocess that reports nothing until it exits.
      // Pretending otherwise would be the one thing a progress bar must not do.
      total: 0,
      message: `Indexing ${String(metadata.sourceFiles)} source files with ${indexer.name}…`,
    });

    const indexResult = await metrics.time('scipIndex', () =>
      indexer.index(loaded.path, {
        outputDirectory: workspaceDirectory,
        timeoutMs: this.deps.scipTimeoutMs,
      }),
    );
    log.info({ durationMs: indexResult.durationMs }, 'SCIP index produced');

    // --- parse ----------------------------------------------------------
    await this.setStatus(job.id, 'PARSING');
    progress.report({
      phase: 'parsing',
      current: 0,
      total: metadata.sourceFiles,
      message: 'Parsing the index…',
    });

    const parsed = await metrics.time('scipDecode', () => readScipIndexFile(indexResult.indexPath));
    const refiner = this.deps.indexers.resolveRefiner(language);
    const index = await metrics.time('scipRefine', () =>
      refiner.refine(parsed, { repositoryPath: loaded.path }),
    );

    const indexedSymbolCount = index.documents.reduce(
      (total, document) => total + document.symbols.length,
      0,
    );
    log.info(
      { documents: index.documents.length, symbols: indexedSymbolCount },
      'SCIP index parsed',
    );

    // One pass over the source, shared by every analyzer, reusing the walk the
    // scan already did.
    const sources = await metrics.time('sourceLoad', () =>
      loadSourceFiles(loaded.path, {
        ...this.deps.sourceReadLimits,
        scan: scanned.scan,
        onProgress: (read, total) => {
          progress.report({
            phase: 'parsing',
            current: read,
            total,
            message: 'Reading source files…',
          });
        },
      }),
    );

    // --- build ----------------------------------------------------------
    const analyzers = [
      new ScipAnalyzer({ index }),
      ...(this.deps.analyzers ?? createDefaultAnalyzers()),
    ];

    // Queued before the status changes, so a poll landing between the two does
    // not see the coarse status of one phase beside the fine report of the
    // previous one.
    progress.report({
      phase: 'resolving',
      current: 0,
      total: analyzers.length,
      message: 'Resolving relationships…',
    });

    await this.setStatus(job.id, 'BUILDING_GRAPH');

    const assembler = new CodeGraphAssembler({
      identity: { projectId: job.projectId, repositoryId: repository.id },
      repositoryName: loaded.name,
      repositoryPath: loaded.path,
      language,
      sources,
      analyzers,
      onProgress: (event) => {
        progress.report({
          phase: 'resolving',
          current: event.completed,
          total: event.total,
          message: `Resolving relationships… ${event.analyzer}`,
          relationships: event.edgeCount,
        });
      },
    });

    const graph = await metrics.time('graphAssembly', () => assembler.assemble());

    // Counted now rather than from the raw index: an index's symbol table also
    // holds every symbol the project *refers* to, and reporting that as
    // "symbols" would mean the progress panel and the statistics panel used one
    // word for two different numbers.
    progress.carry({ symbols: graph.stats.symbolCount });

    progress.report({
      phase: 'building_graph',
      current: graph.nodes.length,
      total: graph.nodes.length,
      message: 'Building the graph…',
      relationships: graph.edges.length,
      errors: graph.errors.length,
    });

    log.info(
      {
        nodes: graph.stats.nodeCount,
        edges: graph.stats.edgeCount,
        analyzers: graph.analyzersRun,
        counters: graph.stats.counters,
        droppedEdges: graph.stats.droppedEdgeCount,
        failedAnalyzers: graph.stats.failedAnalyzerCount,
        unresolvedReferences: graph.stats.unresolvedReferences,
        unreadableFiles: graph.errors.length,
      },
      'code knowledge graph built',
    );
    for (const diagnostic of graph.diagnostics) log.warn({ diagnostic }, 'analysis diagnostic');

    // --- persist --------------------------------------------------------
    await this.setStatus(job.id, 'PERSISTING');
    progress.report({
      phase: 'persisting',
      current: 0,
      total: graph.nodes.length + graph.edges.length,
      message: 'Storing the graph…',
      relationships: graph.edges.length,
      errors: graph.errors.length,
    });

    await metrics.time('persist', () => this.deps.graph.replaceProjectGraph(job.projectId, graph));

    const stats: AnalysisStats = {
      ...this.buildStats(graph, metadata, startedAt),
      completeness: describeCompleteness(graph, sources, scanned.scan.truncated),
      timings: metrics.timings({
        analyzers: graph.analyzerTimings,
        scipIndexerReportedMs: indexResult.durationMs,
      }),
      resources: metrics.resources(indexResult.resources),
    };
    if (stats.completeness?.incomplete) {
      log.warn({ reasons: stats.completeness.reasons }, 'the graph is known to be incomplete');
    }

    await this.deps.analysisJobs.update(job.id, {
      status: 'COMPLETED',
      completedAt: new Date(),
      error: null,
      stats,
      // Capped: the record is for telling someone which files to look at, not
      // for storing a repository's worth of failures.
      errors: graph.errors.slice(0, MAX_RECORDED_ERRORS),
      sourceRevision,
    });

    progress.report({
      phase: 'completed',
      current: 1,
      total: 1,
      message: completionMessage(graph.errors.length, stats.completeness),
      relationships: graph.edges.length,
      errors: graph.errors.length,
    });
    await progress.flush();

    // Successful runs clean up after themselves; failed ones keep their
    // artefacts so the index can be inspected.
    await this.deps.workspace.cleanup(job.id);

    log.info({ stats }, 'analysis completed');
    return stats;
  }

  /**
   * The revision, or null when it could not be taken.
   *
   * Never fatal. A graph whose freshness is unknown is still a graph; failing
   * the run because git misbehaved would trade a caveat for nothing at all.
   */
  private async captureRevision(directory: string, log: Logger): Promise<SourceRevision | null> {
    try {
      const revision = await (this.deps.captureRevision ?? captureSourceRevision)(directory);
      log.info(
        { vcs: revision.vcs, commit: revision.commit, changedFiles: revision.changeCount },
        'source revision captured',
      );
      return revision;
    } catch (error) {
      log.warn({ err: error }, 'source revision could not be captured; freshness will be unknown');
      return null;
    }
  }

  /**
   * Walks the project, turning the scanner's own failure modes into the
   * pipeline's. A path that cannot be read is a failed run — unlike a *file*
   * inside it, which is only a warning.
   */
  private async scan(
    repositoryPath: string,
    onProgress: (filesSeen: number) => void,
  ): Promise<{ metadata: ProjectMetadata; scan: RepositoryScan }> {
    try {
      return await scanProject(repositoryPath, { onProgress });
    } catch (error) {
      if (error instanceof ProjectScanError) {
        throw new AnalysisFailedError(
          error.reason === 'unreadable'
            ? 'permission denied while accessing the project'
            : 'unable to read the project directory',
          'INDEXING',
        );
      }
      throw error;
    }
  }

  /** Everything the completed run measured, and nothing it did not. */
  private buildStats(
    graph: { nodes: Array<{ type: CodeNodeType }>; edges: unknown[]; stats: { documentCount: number; symbolCount: number; nodeCount: number; edgeCount: number }; errors: IndexingError[] },
    metadata: ProjectMetadata,
    startedAt: number,
  ): AnalysisStats {
    const byType = new Map<CodeNodeType, number>();
    for (const node of graph.nodes) {
      byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
    }

    const counts: Partial<AnalysisStats> = {};
    for (const [type, field] of COUNTED_NODE_TYPES) {
      counts[field] = byType.get(type) ?? 0;
    }
    // Functions and methods are one number to a reader: "how much behaviour is
    // in here". They are two node types because a method belongs to a class.
    counts.functionCount = (byType.get('function') ?? 0) + (byType.get('method') ?? 0);

    return {
      documentCount: graph.stats.documentCount,
      symbolCount: graph.stats.symbolCount,
      nodeCount: graph.stats.nodeCount,
      edgeCount: graph.stats.edgeCount,
      durationMs: Date.now() - startedAt,
      fileCount: metadata.totalFiles,
      sourceFileCount: metadata.sourceFiles,
      directoryCount: metadata.directories,
      languages: metadata.languages,
      // What the walk found that is not a language: documents, configuration,
      // schemas, migrations. Without this, "340 files, 120 of them source"
      // reads as a failure rather than as a description.
      fileCategories: metadata.fileCategories,
      parseErrorCount: graph.errors.length,
      ...counts,
    };
  }

  private async resolveLanguage(
    job: AnalysisJob,
    scan: RepositoryScan,
    log: Logger,
  ): Promise<SupportedLanguage> {
    if (job.language) {
      log.info({ language: job.language }, 'language forced by request');
      return job.language;
    }

    // Detection reads the scan we already have rather than walking again.
    const detection = this.deps.languageDetection.detectFromScan(scan);
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

/** Per-file failures kept on the job record. Beyond this it is a pattern, not a list. */
const MAX_RECORDED_ERRORS = 100;

/**
 * What the run is known to have left out.
 *
 * Every count is read from where it was produced, once: the walk's limits from
 * the scan, the read's limits from the source set, unresolved references and
 * dropped edges from the assembler, unreadable files from the merged error
 * list. Nothing here is inferred from the size or shape of the graph.
 */
export function describeCompleteness(
  graph: Pick<AssembledGraph, 'stats' | 'errors' | 'analyzersRun'>,
  sources: Pick<InMemorySourceFileSet, 'truncated' | 'report'>,
  scanTruncated: boolean,
): AnalysisCompleteness {
  const reasons: IncompletenessReason[] = [];
  const read = sources.report;
  const scan = read?.scan ?? null;

  if (scan) {
    if (scan.filesOverLimit > 0) reasons.push('scan_file_limit');
    if (scan.directoriesOverDepth > 0) reasons.push('scan_depth_limit');
    if (scan.aborted) reasons.push('scan_aborted');
    if (scan.unreadableDirectories > 0) reasons.push('unreadable_directories');
  } else if (scanTruncated) {
    // The walk said it stopped early without saying why: still a known
    // truncation, reported under the most general cause.
    reasons.push('scan_file_limit');
  }
  if (read) {
    if (read.fileLimit.reached) reasons.push('source_file_limit');
    if (read.fileSizeLimit.filesSkipped > 0) reasons.push('source_file_size_limit');
    if (read.totalSizeLimit.reached) reasons.push('source_total_size_limit');
  }
  if (graph.errors.length > 0) reasons.push('unreadable_files');
  if (graph.stats.failedAnalyzerCount > 0) reasons.push('analyzer_failed');

  const unresolved = graph.stats.unresolvedReferences;

  return {
    incomplete: reasons.length > 0,
    reasons,
    unresolvedReferences: {
      total: graph.stats.unresolvedReferenceCount,
      external: unresolved.external,
      unmodelled: unresolved.unmodelled,
      unknown: unresolved.unknown,
    },
    droppedEdges: {
      total: graph.stats.droppedEdgeCount,
      byAnalyzer: { ...graph.stats.droppedEdgesByAnalyzer },
    },
    analyzers: { run: [...graph.analyzersRun], failed: [...graph.stats.failedAnalyzers] },
    scan: scan ? { truncated: scanTruncated, ...scan } : null,
    sourceRead: read
      ? {
          truncated: sources.truncated,
          candidateFiles: read.candidateFiles,
          filesRead: read.filesRead,
          bytesRead: read.bytesRead,
          fileLimit: { ...read.fileLimit },
          fileSizeLimit: { ...read.fileSizeLimit },
          totalSizeLimit: { ...read.totalSizeLimit },
        }
      : null,
    unreadableFiles: graph.errors.length,
  };
}

/** The final progress line: says "incomplete" whenever the run knows it is. */
function completionMessage(errorCount: number, completeness: AnalysisCompleteness | undefined): string {
  const limited = (completeness?.reasons ?? []).filter((reason) => reason !== 'unreadable_files');
  if (limited.length > 0) {
    return `Indexed, incomplete: ${limited.join(', ')}${errorCount > 0 ? `; ${String(errorCount)} file(s) could not be parsed` : ''}`;
  }
  return errorCount > 0
    ? `Indexed with warnings: ${String(errorCount)} file(s) could not be parsed`
    : 'Indexing complete';
}
