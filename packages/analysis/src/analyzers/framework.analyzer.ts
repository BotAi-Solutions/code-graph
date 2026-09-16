import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEnrichment,
  CodeAnalyzer,
  CodeNode,
} from '@ckg/graph';
import { decoratorsOf, ts } from '../source/ast.js';
import { moduleSetFor } from '../source/shared.js';
import { readManifest } from '../source/manifest.js';
import { FRAMEWORKS_BY_PACKAGE, type FrameworkKind } from '../detectors/frameworks.js';

/**
 * What this codebase is built with, and what part each class plays in it.
 *
 * Runs last, over the finished graph, because the interesting classification is
 * structural rather than textual. A class is a controller because a route
 * dispatches to it; a repository because something showed it writing to a
 * table; a client because it calls an external service. None of that is a guess
 * about a file name, which is the trap this whole analyzer exists to avoid: in
 * a real codebase `UserService` in `user.service.ts` might be a controller, and
 * `Helpers` might be the only thing touching the database.
 *
 * The one exception is a framework decorator — `@Injectable()`, `@Controller()`
 * — which is a declaration of intent by the author, and therefore better
 * evidence than anything the graph shape can offer.
 *
 * Roles land in `metadata.role` alongside `metadata.roleEvidence`, so the UI can
 * show *why* something was labelled, and nothing has to be taken on trust.
 */

export const CLASS_ROLES = [
  'controller',
  'service',
  'repository',
  'entity',
  'client',
  'guard',
] as const;

export type ClassRole = (typeof CLASS_ROLES)[number];

export class FrameworkAnalyzer implements CodeAnalyzer {
  readonly name = 'framework-analyzer';
  readonly stage: AnalysisStage = 'classification';

  supports(context: AnalysisContext): boolean {
    return context.symbols.size > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const enrichments: AnalyzerEnrichment[] = [];

    const frameworks = this.frameworks(context);
    const decorated = this.decoratorRoles(context);

    // Frameworks are a property of the repository and of the service in it.
    if (frameworks.length > 0) {
      const repository = context.symbols.repository();
      if (repository) {
        enrichments.push({ nodeId: repository.id, metadata: { frameworks } });
      }
      for (const service of context.symbols.ofType('service')) {
        enrichments.push({ nodeId: service.id, metadata: { frameworks } });
      }
    }

    const roleCounts: Record<string, number> = {};

    for (const node of [...context.symbols.ofType('class'), ...context.symbols.ofType('interface')]) {
      const classified = this.roleOf(context, node, decorated);
      if (!classified) continue;

      roleCounts[classified.role] = (roleCounts[classified.role] ?? 0) + 1;
      enrichments.push({
        nodeId: node.id,
        metadata: { role: classified.role, roleEvidence: classified.evidence },
      });
    }

    return {
      enrichments,
      stats: {
        frameworkCount: frameworks.length,
        ...Object.fromEntries(
          Object.entries(roleCounts).map(([role, count]) => [`${role}Count`, count]),
        ),
      },
    };
  }

  /** Frameworks in use, from the manifest and from what the code imports. */
  private frameworks(context: AnalysisContext): FrameworkKind[] {
    const found = new Set<FrameworkKind>();

    const manifest = readManifest(context.sources);
    for (const packageName of Object.keys(manifest?.dependencies ?? {})) {
      const framework = FRAMEWORKS_BY_PACKAGE.get(packageName);
      if (framework) found.add(framework);
    }

    for (const module of moduleSetFor(context.sources).modules()) {
      for (const packageName of module.bindings.packages()) {
        const framework = FRAMEWORKS_BY_PACKAGE.get(packageName);
        if (framework) found.add(framework);
      }
    }

    return [...found].sort();
  }

  /**
   * Roles their author declared with a decorator, keyed by node id.
   *
   * The decorator must come from the framework's own package — the same
   * standard the API analyzer holds itself to.
   */
  private decoratorRoles(context: AnalysisContext): Map<string, { role: ClassRole; evidence: string }> {
    const roles = new Map<string, { role: ClassRole; evidence: string }>();

    const byDecorator: ReadonlyMap<string, ClassRole> = new Map([
      ['Controller', 'controller'],
      ['Injectable', 'service'],
      ['Entity', 'entity'],
      ['Table', 'entity'],
      ['Repository', 'repository'],
      ['EntityRepository', 'repository'],
    ]);

    for (const module of moduleSetFor(context.sources).modules()) {
      for (const statement of module.sourceFile.statements) {
        if (!ts.isClassDeclaration(statement) || !statement.name) continue;

        const node = context.symbols.declaration(module.relativePath, statement.name.text, [
          'class',
        ]);
        if (!node) continue;

        for (const decorator of decoratorsOf(statement)) {
          const role = byDecorator.get(decorator.name);
          if (!role) continue;

          const binding = module.bindings.get(decorator.name);
          if (binding?.kind !== 'package') continue;

          // A guard is an injectable that implements the framework's guard
          // interface; recording it separately keeps `AUTHENTICATED_BY` targets
          // recognisable in the inspector.
          const resolved =
            role === 'service' && implementsGuard(statement) ? ('guard' as ClassRole) : role;

          roles.set(node.id, {
            role: resolved,
            evidence: `@${decorator.name} from ${binding.packageName}`,
          });
          break;
        }
      }
    }

    return roles;
  }

  /** The part a class plays, decided by evidence rather than by its name. */
  private roleOf(
    context: AnalysisContext,
    node: CodeNode,
    decorated: ReadonlyMap<string, { role: ClassRole; evidence: string }>,
  ): { role: ClassRole; evidence: string } | null {
    const declared = decorated.get(node.id);
    if (declared) return declared;

    const { symbols } = context;

    // A route dispatches to it, or to one of its methods.
    if (symbols.hasRelationship(node.id, 'ROUTES_TO', 'incoming', true)) {
      return { role: 'controller', evidence: 'an API route dispatches to it' };
    }

    // It reads or writes a table, itself or through its methods.
    const touchesTable =
      symbols.hasRelationship(node.id, 'WRITES_TO', 'outgoing', true) ||
      symbols.hasRelationship(node.id, 'READS_FROM', 'outgoing', true);

    if (touchesTable) {
      return { role: 'repository', evidence: 'it reads or writes a database table' };
    }

    // It is a table's mapping.
    const mapsTable = symbols
      .related(node.id, 'USES', 'outgoing')
      .some((target) => target.type === 'table');
    if (mapsTable) {
      return { role: 'entity', evidence: 'it maps to a database table' };
    }

    // It calls out of the process.
    const callsExternal = symbols
      .related(node.id, 'CALLS', 'outgoing')
      .some((target) => target.type === 'external_service');
    if (callsExternal) {
      return { role: 'client', evidence: 'it calls an external service' };
    }

    // It sits between a controller and something that persists or integrates:
    // the definition of an application service, stated structurally.
    if (this.isIntermediary(context, node)) {
      return { role: 'service', evidence: 'a controller calls it and it calls a repository' };
    }

    return null;
  }

  private isIntermediary(context: AnalysisContext, node: CodeNode): boolean {
    const { symbols } = context;

    const calledByController = symbols
      .related(node.id, 'CALLS', 'incoming')
      .some((caller) => symbols.hasRelationship(caller.id, 'ROUTES_TO', 'incoming', true));

    if (!calledByController) return false;

    return symbols.related(node.id, 'CALLS', 'outgoing').some(
      (callee) =>
        callee.type === 'external_service' ||
        symbols.hasRelationship(callee.id, 'WRITES_TO', 'outgoing', true) ||
        symbols.hasRelationship(callee.id, 'READS_FROM', 'outgoing', true) ||
        symbols.related(callee.id, 'PUBLISHES', 'outgoing').length > 0,
    );
  }
}

/** `implements CanActivate` — NestJS's guard contract. */
function implementsGuard(statement: ts.ClassDeclaration): boolean {
  for (const clause of statement.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;

    for (const type of clause.types) {
      const name = ts.isIdentifier(type.expression) ? type.expression.text : null;
      if (name === 'CanActivate') return true;
    }
  }
  return false;
}
