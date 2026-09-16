import type { ScipIndex } from '@ckg/scip';
import { ScipGraphBuilder } from '../builder/scip-graph-builder.js';
import type { AnalysisContext, AnalysisResult, AnalysisStage, CodeAnalyzer } from './analyzer.js';

/**
 * The code-intelligence stage: SCIP.
 *
 * A thin wrapper so the compiler's view enters the pipeline through the same
 * door as every other source of facts. The work still happens in
 * `ScipGraphBuilder`, which is unchanged and remains the authority on symbols,
 * definitions, references, calls, implementations and containment.
 */
export class ScipAnalyzer implements CodeAnalyzer {
  readonly name = 'scip';
  readonly stage: AnalysisStage = 'code-intelligence';

  constructor(
    private readonly options: {
      index: ScipIndex;
      deriveContainerEdges?: boolean | undefined;
    },
  ) {}

  supports(): boolean {
    return true;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const builder = new ScipGraphBuilder({
      identity: context.identity,
      repositoryName: context.repositoryName,
      ...(this.options.deriveContainerEdges !== undefined
        ? { deriveContainerEdges: this.options.deriveContainerEdges }
        : {}),
    });

    const built = builder.build(this.options.index);

    return {
      graph: { nodes: built.nodes, edges: built.edges },
      stats: {
        documentCount: built.stats.documentCount,
        symbolCount: built.stats.symbolCount,
        unresolvedReferenceCount: built.stats.unresolvedReferenceCount,
      },
    };
  }
}
