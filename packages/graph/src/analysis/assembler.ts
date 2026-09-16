import type { CodeGraph, IndexingError, SupportedLanguage } from '@ckg/shared';
import { EdgeAccumulator } from '../builder/edge-accumulator.js';
import { NodeAccumulator } from '../builder/node-accumulator.js';
import type { GraphIdentityContext } from '../model/identity.js';
import {
  ANALYSIS_STAGES,
  type AnalysisContext,
  type AnalyzerEdgeDraft,
  type CodeAnalyzer,
  type NodeReference,
  type SourceFileSet,
} from './analyzer.js';
import { SymbolIndex } from './symbol-index.js';

/**
 * Runs the analyzers and merges what they found into one graph.
 *
 *   SCIP  ──▶ code knowledge graph ──▶ source analyzers ──▶ same graph, richer
 *
 * Merge rules, in one place because they are what keeps the result trustworthy:
 *
 * - **Identity decides everything.** Two analyzers describing the same thing
 *   produce the same id and therefore one node. There is no fuzzy matching.
 * - **First writer wins for nodes.** Stages run in order, so a node the
 *   compiler already described is never replaced by an analyzer's version of
 *   it; an analyzer adds to it with an enrichment instead.
 * - **No edge without both endpoints.** An edge naming a node that does not
 *   exist is dropped and counted, never silently backed by an invented node.
 * - **Every edge carries evidence.** The accumulator requires it.
 * - **One analyzer cannot end the run.** An analyzer that throws is recorded
 *   and skipped; the other seven still have things to say about a repository,
 *   and a graph missing one analyzer's findings is worth far more than no
 *   graph at all.
 *
 * The whole pass is deterministic: analyzers run in a fixed order, each works
 * from a path-sorted file list, and both output arrays are sorted by id.
 */

/** Reported as each analyzer finishes, so a caller can show real progress. */
export interface AssemblyProgress {
  analyzer: string;
  /** Analyzers finished, including this one. */
  completed: number;
  /** Analyzers that will run in total. Known before the first one starts. */
  total: number;
  nodeCount: number;
  edgeCount: number;
}

export interface CodeGraphAssemblerOptions {
  identity: GraphIdentityContext;
  repositoryName: string;
  /** Absolute path of the working tree, for analyzers that resolve modules. */
  repositoryPath: string;
  sources: SourceFileSet;
  language?: SupportedLanguage | null;
  analyzers: readonly CodeAnalyzer[];
  /**
   * Called after each analyzer. Optional and synchronous: the assembler reports
   * where it is, and what the caller does with that — throttle it, write it to
   * a database, ignore it — is the caller's business.
   */
  onProgress?: ((progress: AssemblyProgress) => void) | undefined;
}

export interface AssembledGraphStats {
  documentCount: number;
  symbolCount: number;
  nodeCount: number;
  edgeCount: number;
  unresolvedReferenceCount: number;
  /** Edges an analyzer described whose endpoints were not both in the graph. */
  droppedEdgeCount: number;
  /** Per-analyzer counters, keyed `<analyzer>.<counter>`. */
  counters: Record<string, number>;
  /** Analyzers that threw and were skipped. */
  failedAnalyzerCount: number;
}

export interface AssembledGraph extends CodeGraph {
  stats: AssembledGraphStats;
  diagnostics: string[];
  /** Analyzers that actually ran, in execution order. */
  analyzersRun: string[];
  /** Files that could not be read or parsed, deduplicated by path. */
  errors: IndexingError[];
}

export class CodeGraphAssembler {
  constructor(private readonly options: CodeGraphAssemblerOptions) {}

  async assemble(): Promise<AssembledGraph> {
    const nodes = new NodeAccumulator(this.options.identity);
    const edges = new EdgeAccumulator(this.options.identity);

    const diagnostics: string[] = [];
    const counters: Record<string, number> = {};
    const analyzersRun: string[] = [];
    // Keyed by path: several analyzers parsing the same broken file must not
    // make it look like several broken files.
    const errors = new Map<string, IndexingError>();

    for (const failure of this.options.sources.failures) {
      errors.set(failure.file, failure);
    }

    let symbols = new SymbolIndex();
    let droppedEdgeCount = 0;
    let documentCount = 0;
    let symbolCount = 0;
    let unresolvedReferenceCount = 0;
    let failedAnalyzerCount = 0;
    let completedAnalyzers = 0;

    // Known up front, because `supports()` is a cheap check against a context
    // that does not change during a stage. A progress total that grows as it
    // goes is not a total.
    const plannedAnalyzers = this.options.analyzers.length;

    for (const stage of ANALYSIS_STAGES) {
      const staged = this.options.analyzers.filter((analyzer) => analyzer.stage === stage);
      if (staged.length === 0) continue;

      for (const analyzer of staged) {
        const context: AnalysisContext = {
          identity: this.options.identity,
          repositoryPath: this.options.repositoryPath,
          repositoryName: this.options.repositoryName,
          language: this.options.language ?? null,
          sources: this.options.sources,
          symbols,
        };

        if (!analyzer.supports(context)) {
          completedAnalyzers += 1;
          continue;
        }
        analyzersRun.push(analyzer.name);

        let result;
        try {
          result = await analyzer.analyze(context);
        } catch (error) {
          // One analyzer's bug is not the repository's problem. Record it where
          // an operator will see it and carry on with the rest.
          failedAnalyzerCount += 1;
          completedAnalyzers += 1;
          diagnostics.push(
            `${analyzer.name}: failed and was skipped — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          this.options.onProgress?.({
            analyzer: analyzer.name,
            completed: completedAnalyzers,
            total: plannedAnalyzers,
            nodeCount: nodes.size,
            edgeCount: edges.size,
          });
          continue;
        }

        if (result.graph) {
          for (const node of result.graph.nodes) nodes.seed(node);
          for (const edge of result.graph.edges) edges.seed(edge);
        }

        for (const draft of result.nodes ?? []) nodes.add(draft);

        for (const edge of result.edges ?? []) {
          if (!this.mergeEdge(nodes, edges, edge)) {
            droppedEdgeCount += 1;
          }
        }

        for (const enrichment of result.enrichments ?? []) {
          nodes.enrich(enrichment.nodeId, enrichment.metadata);
        }

        for (const [name, value] of Object.entries(result.stats ?? {})) {
          if (name === 'documentCount') documentCount = Math.max(documentCount, value);
          else if (name === 'symbolCount') symbolCount = Math.max(symbolCount, value);
          else if (name === 'unresolvedReferenceCount') unresolvedReferenceCount += value;
          else counters[`${analyzer.name}.${name}`] = value;
        }

        for (const note of result.diagnostics ?? []) {
          diagnostics.push(`${analyzer.name}: ${note}`);
        }

        for (const failure of result.errors ?? []) {
          if (!errors.has(failure.file)) errors.set(failure.file, failure);
        }

        completedAnalyzers += 1;
        this.options.onProgress?.({
          analyzer: analyzer.name,
          completed: completedAnalyzers,
          total: plannedAnalyzers,
          nodeCount: nodes.size,
          edgeCount: edges.size,
        });
      }

      // Later stages resolve their findings against everything found so far.
      symbols = new SymbolIndex({ nodes: nodes.toArray(), edges: edges.toArray() });
    }

    const nodeArray = nodes.toArray();
    const edgeArray = edges.toArray();

    return {
      nodes: nodeArray,
      edges: edgeArray,
      diagnostics,
      analyzersRun,
      // Path order, so two runs over the same repository report the same list.
      errors: [...errors.values()].sort((a, b) => a.file.localeCompare(b.file)),
      stats: {
        documentCount,
        symbolCount,
        nodeCount: nodeArray.length,
        edgeCount: edgeArray.length,
        unresolvedReferenceCount,
        droppedEdgeCount,
        counters,
        failedAnalyzerCount,
      },
    };
  }

  /** Resolves both endpoints and records the edge. False when it cannot. */
  private mergeEdge(
    nodes: NodeAccumulator,
    edges: EdgeAccumulator,
    edge: AnalyzerEdgeDraft,
  ): boolean {
    const source = resolve(nodes, edge.from);
    const target = resolve(nodes, edge.to);

    if (!source || !target || source === target) return false;

    edges.add(source, edge.relationship, target, {
      evidence: edge.evidence,
      ...(edge.metadata ? { metadata: edge.metadata } : {}),
    });
    return true;
  }
}

function resolve(nodes: NodeAccumulator, reference: NodeReference): string | null {
  if (reference.kind === 'node') {
    return nodes.has(reference.id) ? reference.id : null;
  }
  const id = nodes.idFor(reference.draft);
  return nodes.has(id) ? id : null;
}
