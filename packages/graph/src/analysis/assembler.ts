import type { CodeGraph, SupportedLanguage } from '@ckg/shared';
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
 *
 * The whole pass is deterministic: analyzers run in a fixed order, each works
 * from a path-sorted file list, and both output arrays are sorted by id.
 */

export interface CodeGraphAssemblerOptions {
  identity: GraphIdentityContext;
  repositoryName: string;
  /** Absolute path of the working tree, for analyzers that resolve modules. */
  repositoryPath: string;
  sources: SourceFileSet;
  language?: SupportedLanguage | null;
  analyzers: readonly CodeAnalyzer[];
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
}

export interface AssembledGraph extends CodeGraph {
  stats: AssembledGraphStats;
  diagnostics: string[];
  /** Analyzers that actually ran, in execution order. */
  analyzersRun: string[];
}

export class CodeGraphAssembler {
  constructor(private readonly options: CodeGraphAssemblerOptions) {}

  async assemble(): Promise<AssembledGraph> {
    const nodes = new NodeAccumulator(this.options.identity);
    const edges = new EdgeAccumulator(this.options.identity);

    const diagnostics: string[] = [];
    const counters: Record<string, number> = {};
    const analyzersRun: string[] = [];

    let symbols = new SymbolIndex();
    let droppedEdgeCount = 0;
    let documentCount = 0;
    let symbolCount = 0;
    let unresolvedReferenceCount = 0;

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

        if (!analyzer.supports(context)) continue;
        analyzersRun.push(analyzer.name);

        const result = await analyzer.analyze(context);

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
      stats: {
        documentCount,
        symbolCount,
        nodeCount: nodeArray.length,
        edgeCount: edgeArray.length,
        unresolvedReferenceCount,
        droppedEdgeCount,
        counters,
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
