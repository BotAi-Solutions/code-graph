import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEdgeDraft,
  CodeAnalyzer,
  CodeNode,
} from '@ckg/graph';
import { nodeRef } from '@ckg/graph';
import type { EdgeEvidence } from '@ckg/shared';
import { lineOf, ts, typeReferenceNames, walk } from '../source/ast.js';
import { resolveName, resolveTypeName, resolveValueType } from '../source/resolve.js';
import { moduleSetFor } from '../source/shared.js';
import type { ParsedModule } from '../source/module-set.js';

/**
 * Relationships the compiler knows but SCIP does not distinguish.
 *
 * SCIP reports an *occurrence* of `User` and leaves it at that. Whether that
 * occurrence was a construction, a parameter type or a return type is written
 * in the syntax, and the difference is what lets the graph answer "what does
 * this function take and give back" rather than only "what does it mention".
 *
 * Every edge here is resolved through the file's import bindings, so a type
 * name only ever attaches to the declaration it actually refers to.
 */

const EVIDENCE: EdgeEvidence = { source: 'structure-analyzer', confidence: 'high' };

export class StructureAnalyzer implements CodeAnalyzer {
  readonly name = 'structure-analyzer';
  readonly stage: AnalysisStage = 'source';

  supports(context: AnalysisContext): boolean {
    return context.symbols.size > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const modules = moduleSetFor(context.sources);
    const resolution = { symbols: context.symbols, modules };

    const edges: AnalyzerEdgeDraft[] = [];
    let instantiations = 0;
    let signatures = 0;

    for (const module of modules.modules()) {
      if (!context.symbols.file(module.relativePath)) continue;

      walk(module.sourceFile, (node) => {
        if (ts.isNewExpression(node)) {
          const line = lineOf(module.sourceFile, node);
          const source = context.symbols.enclosingDefinition(module.relativePath, line);
          const target = resolveValueType(resolution, module, node.expression);

          if (source && target && source.id !== target.id) {
            instantiations += 1;
            edges.push({
              from: nodeRef(source.id),
              to: nodeRef(target.id),
              relationship: 'INSTANTIATES',
              evidence: EVIDENCE,
              metadata: { line },
            });
          }
          return;
        }

        if (
          ts.isMethodDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isConstructorDeclaration(node)
        ) {
          signatures += this.signatureEdges(context, resolution, module, node, edges);
        }
      });
    }

    return {
      edges,
      stats: { instantiationCount: instantiations, signatureCount: signatures },
    };
  }

  /** ACCEPTS for each named parameter type, RETURNS for the return type. */
  private signatureEdges(
    context: AnalysisContext,
    resolution: { symbols: AnalysisContext['symbols']; modules: ReturnType<typeof moduleSetFor> },
    module: ParsedModule,
    declaration: ts.SignatureDeclaration,
    edges: AnalyzerEdgeDraft[],
  ): number {
    const line = lineOf(module.sourceFile, declaration);
    const owner = this.declaredNode(context, module, declaration, line);
    if (!owner) return 0;

    let emitted = 0;

    for (const parameter of declaration.parameters) {
      for (const typeName of typeReferenceNames(parameter.type)) {
        const target = resolveTypeName(resolution, module, typeName);
        if (!target || target.id === owner.id) continue;

        emitted += 1;
        edges.push({
          from: nodeRef(owner.id),
          to: nodeRef(target.id),
          relationship: 'ACCEPTS',
          evidence: EVIDENCE,
          metadata: {
            parameter: ts.isIdentifier(parameter.name) ? parameter.name.text : undefined,
          },
        });
      }
    }

    for (const typeName of typeReferenceNames(declaration.type)) {
      // `Promise<User>` mentions both; `Promise` is not in the graph, so it
      // resolves to nothing and only `User` produces an edge.
      const target = resolveTypeName(resolution, module, typeName);
      if (!target || target.id === owner.id) continue;

      emitted += 1;
      edges.push({
        from: nodeRef(owner.id),
        to: nodeRef(target.id),
        relationship: 'RETURNS',
        evidence: EVIDENCE,
      });
    }

    return emitted;
  }

  /** The graph node for a declaration, by name rather than by position. */
  private declaredNode(
    context: AnalysisContext,
    module: ParsedModule,
    declaration: ts.SignatureDeclaration,
    line: number,
  ): CodeNode | undefined {
    if (ts.isConstructorDeclaration(declaration)) {
      // Constructors are members named `<constructor>` by the indexer; the
      // enclosing definition lookup finds them without guessing the spelling.
      return context.symbols.enclosingDefinition(module.relativePath, line);
    }

    const name = declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
    if (name === null) {
      return context.symbols.enclosingDefinition(module.relativePath, line);
    }

    if (ts.isMethodDeclaration(declaration)) {
      const owner = declaration.parent;
      const ownerName =
        ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)
          ? owner.name?.text
          : undefined;

      if (ownerName) {
        return context.symbols.member(module.relativePath, ownerName, name, ['method']);
      }
    }

    return (
      context.symbols.declaration(module.relativePath, name, ['function', 'method']) ??
      context.symbols.enclosingDefinition(module.relativePath, line)
    );
  }
}

export { resolveName };
