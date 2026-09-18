import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEdgeDraft,
  AnalyzerEnrichment,
  AnalyzerNodeDraft,
  CodeAnalyzer,
} from '@ckg/graph';
import { draftRef, nodeRef } from '@ckg/graph';
import type { EdgeEvidence } from '@ckg/shared';
import { configDraft, configKindOf } from '../source/config-node.js';
import { readManifest } from '../source/manifest.js';
import { serviceDraftFor } from '../source/service-node.js';

/**
 * The repository as a deployable thing, and the files that configure it.
 *
 * SCIP describes symbols; it has nothing to say about the fact that this
 * directory is a service called `orders-service` configured by three files.
 * Those are facts about the repository, they are unambiguous — the manifest
 * says so — and they are what the dependency and architecture projections hang
 * off of.
 */

const EVIDENCE: EdgeEvidence = { source: 'file-analyzer', confidence: 'high' };

export class FileAnalyzer implements CodeAnalyzer {
  readonly name = 'file-analyzer';
  readonly stage: AnalysisStage = 'source';

  supports(context: AnalysisContext): boolean {
    return context.sources.all().length > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const nodes: AnalyzerNodeDraft[] = [];
    const edges: AnalyzerEdgeDraft[] = [];
    const enrichments: AnalyzerEnrichment[] = [];

    const repository = context.symbols.repository();
    const manifest = readManifest(context.sources);

    const service = serviceDraftFor(manifest);

    if (service) {
      nodes.push(service);
      if (repository) {
        edges.push({
          from: nodeRef(repository.id),
          to: draftRef(service),
          relationship: 'CONTAINS',
          evidence: EVIDENCE,
          metadata: { declaredIn: 'package.json' },
        });
      }
    }

    // Whatever the service is configured by is attached to the service when we
    // found one, and to the repository otherwise — never to nothing, which
    // would leave the config nodes unreachable by traversal.
    const configurationOwner = service ? draftRef(service) : repository ? nodeRef(repository.id) : null;

    let configCount = 0;

    for (const file of context.sources.all()) {
      const kind = configKindOf(file.relativePath);
      if (kind === null) continue;

      configCount += 1;

      // A file the compiler indexed is already a node. `vite.config.ts` is
      // configuration *and* code, and representing it twice would put two
      // nodes on the canvas for one file — so the existing node learns what it
      // is instead.
      const indexed = context.symbols.file(file.relativePath);

      const target = indexed
        ? { ref: nodeRef(indexed.id), enrich: true }
        : { ref: draftRef(configDraft(file.relativePath, kind)), enrich: false };

      if (indexed) {
        enrichments.push({ nodeId: indexed.id, metadata: { configKind: kind } });
      } else {
        nodes.push(configDraft(file.relativePath, kind));
      }

      if (configurationOwner) {
        edges.push({
          from: configurationOwner,
          to: target.ref,
          relationship: 'CONFIGURED_BY',
          evidence: EVIDENCE,
          ...(indexed ? { metadata: { configKind: kind } } : {}),
        });
      }
    }

    return {
      nodes,
      edges,
      enrichments,
      stats: { configCount },
      ...(context.sources.truncated
        ? { diagnostics: ['source file cap reached; some files were not analysed'] }
        : {}),
    };
  }
}

export { configKindOf };
