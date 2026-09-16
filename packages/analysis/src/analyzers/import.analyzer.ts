import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEdgeDraft,
  AnalyzerNodeDraft,
  CodeAnalyzer,
  NodeReference,
} from '@ckg/graph';
import { draftRef, nodeRef } from '@ckg/graph';
import type { EdgeEvidence } from '@ckg/shared';
import { declaredPackages, readManifest } from '../source/manifest.js';
import { serviceDraftFor } from '../source/service-node.js';
import { moduleSetFor } from '../source/shared.js';
import { resolveExport } from '../source/resolve.js';

/**
 * Imports, exports and dependencies, read from the import statements.
 *
 * SCIP gives cross-file `IMPORTS` edges as a side effect of references, which
 * misses two things that matter: a type-only or side-effect-only import is a
 * real dependency with no reference to show for it, and a dependency on an
 * external package is not in the index at all because the package was never
 * indexed. Both are plainly written in the source, so both are read from it.
 */

const EVIDENCE: EdgeEvidence = { source: 'import-analyzer', confidence: 'high' };
/** A package imported but never declared: real, but the manifest disagrees. */
const UNDECLARED_EVIDENCE: EdgeEvidence = { source: 'import-analyzer', confidence: 'medium' };

export class ImportAnalyzer implements CodeAnalyzer {
  readonly name = 'import-analyzer';
  readonly stage: AnalysisStage = 'source';

  supports(context: AnalysisContext): boolean {
    return context.symbols.size > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const modules = moduleSetFor(context.sources);
    const resolution = { symbols: context.symbols, modules };

    const manifest = readManifest(context.sources);
    const declared = declaredPackages(manifest);

    const nodes = new Map<string, AnalyzerNodeDraft>();
    const edges: AnalyzerEdgeDraft[] = [];

    // Declared rather than looked up: the service node is created in this same
    // stage, so the symbol index does not have it yet. Same draft, same id.
    const service = serviceDraftFor(manifest);
    if (service) nodes.set(service.symbolKey, service);
    const serviceRef: NodeReference | null = service ? draftRef(service) : null;

    let exportCount = 0;

    // Declared dependencies are facts about the service whether or not any file
    // imports them.
    for (const [packageName, range] of Object.entries(manifest?.dependencies ?? {})) {
      const draft = packageDraft(packageName, { declared: true, range });
      nodes.set(draft.symbolKey, draft);

      if (serviceRef) {
        edges.push({
          from: serviceRef,
          to: draftRef(draft),
          relationship: 'DEPENDS_ON',
          evidence: EVIDENCE,
          metadata: { declaredIn: 'package.json', range },
        });
      }
    }

    for (const module of modules.modules()) {
      const fileNode = context.symbols.file(module.relativePath);
      if (!fileNode) continue;

      const from = nodeRef(fileNode.id);

      for (const targetPath of module.bindings.files()) {
        const target = context.symbols.file(targetPath);
        if (!target || target.id === fileNode.id) continue;

        edges.push({
          from,
          to: nodeRef(target.id),
          relationship: 'IMPORTS',
          evidence: EVIDENCE,
        });
      }

      for (const packageName of module.bindings.packages()) {
        const isDeclared = declared.has(packageName);
        const existing = nodes.get(`package:${packageName}`);
        const draft = existing ?? packageDraft(packageName, { declared: isDeclared });
        nodes.set(draft.symbolKey, draft);

        edges.push({
          from,
          to: draftRef(draft),
          relationship: 'DEPENDS_ON',
          evidence: isDeclared ? EVIDENCE : UNDECLARED_EVIDENCE,
          ...(isDeclared ? {} : { metadata: { undeclared: true } }),
        });

        if (serviceRef && !isDeclared) {
          edges.push({
            from: serviceRef,
            to: draftRef(draft),
            relationship: 'DEPENDS_ON',
            evidence: UNDECLARED_EVIDENCE,
            metadata: { undeclared: true },
          });
        }
      }

      for (const sideEffect of module.bindings.sideEffects()) {
        if (sideEffect.module.kind === 'file') {
          const target = context.symbols.file(sideEffect.module.relativePath);
          if (target && target.id !== fileNode.id) {
            edges.push({
              from,
              to: nodeRef(target.id),
              relationship: 'IMPORTS',
              evidence: EVIDENCE,
              metadata: { sideEffectOnly: true },
            });
          }
        }
      }

      // Exports: what this file offers the rest of the repository.
      for (const exported of module.bindings.exports()) {
        const target = context.symbols.declaration(module.relativePath, exported.localName);
        if (!target) continue;

        exportCount += 1;
        edges.push({
          from,
          to: nodeRef(target.id),
          relationship: 'EXPORTS',
          evidence: EVIDENCE,
          ...(exported.exportedName === exported.localName
            ? {}
            : { metadata: { exportedAs: exported.exportedName } }),
        });
      }

      for (const reexport of module.bindings.reexported()) {
        const target = resolveExport(
          resolution,
          reexport.from,
          reexport.localName,
          reexport.localName,
        );
        if (!target) continue;

        exportCount += 1;
        edges.push({
          from,
          to: nodeRef(target.id),
          relationship: 'EXPORTS',
          evidence: EVIDENCE,
          metadata: { reexportedFrom: reexport.from },
        });
      }
    }

    return {
      nodes: [...nodes.values()],
      edges,
      stats: { packageCount: nodes.size, exportCount },
    };
  }
}

/**
 * An external package. Modelled as a `module` node — it is a module scope that
 * is not a file — with `external: true`, which is what the dependencies
 * projection selects on.
 */
function packageDraft(
  packageName: string,
  options: { declared: boolean; range?: string },
): AnalyzerNodeDraft {
  const metadata: Record<string, unknown> = { external: true, declared: options.declared };
  if (options.range) metadata.range = options.range;

  return {
    type: 'module',
    name: packageName,
    symbolKey: `package:${packageName}`,
    qualifiedName: packageName,
    metadata,
  };
}
