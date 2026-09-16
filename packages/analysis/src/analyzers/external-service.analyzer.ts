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
import { lineOf, templateText, ts, walk } from '../source/ast.js';
import { attribute, type Resolution } from '../source/resolve.js';
import { moduleSetFor } from '../source/shared.js';
import { readManifest } from '../source/manifest.js';
import { serviceDraftFor } from '../source/service-node.js';
import type { ParsedModule } from '../source/module-set.js';
import {
  hostOfUrl,
  isPlaceholderHost,
  vendorForHost,
  vendorForPackage,
  type ExternalServiceVendor,
} from '../detectors/external-services.js';

/**
 * Third-party services this codebase talks to.
 *
 * Two kinds of evidence, both direct. A vendor SDK imported by name is an
 * unambiguous dependency on that vendor. An absolute `https://` URL written in
 * the source names a host the code will call — and where the host is one we
 * recognise, the vendor too.
 *
 * What is not done here matters as much: no dependency is invented from a
 * comment, a variable name or a string that merely looks like a domain.
 * Loopback and the reserved example domains are excluded, because a fixture URL
 * is not an integration. If the evidence is a URL in a place we cannot tie to a
 * call, the finding is recorded at `medium` rather than dropped or promoted.
 */

const IMPORT_EVIDENCE: EdgeEvidence = { source: 'external-service-analyzer', confidence: 'high' };
const CALL_EVIDENCE: EdgeEvidence = { source: 'external-service-analyzer', confidence: 'high' };
/** A URL held in a field or constant, not itself inside a call. */
const CONFIGURED_EVIDENCE: EdgeEvidence = {
  source: 'external-service-analyzer',
  confidence: 'medium',
};
/** Lifting a member's call to the class that owns it is a summary. */
const CONTAINER_EVIDENCE: EdgeEvidence = {
  source: 'external-service-analyzer',
  confidence: 'medium',
};

export class ExternalServiceAnalyzer implements CodeAnalyzer {
  readonly name = 'external-service-analyzer';
  readonly stage: AnalysisStage = 'source';

  supports(context: AnalysisContext): boolean {
    return context.symbols.size > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const modules = moduleSetFor(context.sources);
    const resolution: Resolution = { symbols: context.symbols, modules };

    const manifest = readManifest(context.sources);

    const nodes = new Map<string, AnalyzerNodeDraft>();
    const edges: AnalyzerEdgeDraft[] = [];

    // Declared rather than looked up: the service node is created in this same
    // stage by the file analyzer, and an identical draft is the same node.
    const service = serviceDraftFor(manifest);
    if (service) nodes.set(service.symbolKey, service);
    const serviceRef: NodeReference | null = service ? draftRef(service) : null;
    const dependedOn = new Set<string>();

    const reference = (draft: AnalyzerNodeDraft): NodeReference => {
      nodes.set(draft.symbolKey, nodes.get(draft.symbolKey) ?? draft);

      // The service depends on every external service any of its code reaches.
      if (serviceRef && !dependedOn.has(draft.symbolKey)) {
        dependedOn.add(draft.symbolKey);
        edges.push({
          from: serviceRef,
          to: draftRef(draft),
          relationship: 'DEPENDS_ON_SERVICE',
          evidence: IMPORT_EVIDENCE,
        });
      }
      return draftRef(draft);
    };

    for (const module of modules.modules()) {
      const fileNode = context.symbols.file(module.relativePath);
      if (!fileNode) continue;

      // --- vendor SDKs --------------------------------------------------
      for (const packageName of module.bindings.packages()) {
        const vendor = vendorForPackage(packageName);
        if (!vendor) continue;

        const draft = vendorDraft(vendor, { package: packageName, known: true });
        const target = reference(draft);

        edges.push({
          from: nodeRef(fileNode.id),
          to: target,
          relationship: 'USES',
          evidence: IMPORT_EVIDENCE,
          metadata: { via: 'import', package: packageName },
        });

        // Where the SDK is actually exercised, the class that does it CALLS the
        // service — which is the edge the architecture view is about.
        for (const use of this.sdkUses(module, packageName)) {
          const { definition, container } = attribute(resolution, module.relativePath, use.line);

          for (const from of [definition, container]) {
            if (!from) continue;
            const lifted = from === container && container.id !== definition?.id;

            edges.push({
              from: nodeRef(from.id),
              to: target,
              relationship: 'CALLS',
              evidence: lifted ? CONTAINER_EVIDENCE : CALL_EVIDENCE,
              metadata: {
                via: 'sdk',
                package: packageName,
                line: use.line,
                ...(lifted ? { derived: true } : {}),
              },
            });
          }
        }
      }

      // --- absolute URLs -------------------------------------------------
      for (const found of this.urlLiterals(module)) {
        const known = vendorForHost(found.host);
        const vendor = known ?? { name: found.host, category: 'http' };

        const draft = vendorDraft(vendor, { host: found.host, known: known !== null });
        const target = reference(draft);

        const { definition, container } = attribute(resolution, module.relativePath, found.line);
        const evidence = found.insideCall ? CALL_EVIDENCE : CONFIGURED_EVIDENCE;

        const endpoints = definition ? [definition, container] : [container];
        let attributed = false;

        for (const from of endpoints) {
          if (!from) continue;
          attributed = true;
          const lifted = from === container && container.id !== definition?.id;

          edges.push({
            from: nodeRef(from.id),
            to: target,
            relationship: 'CALLS',
            evidence: lifted ? CONTAINER_EVIDENCE : evidence,
            metadata: {
              via: found.insideCall ? 'http-call' : 'configured-url',
              host: found.host,
              line: found.line,
              ...(lifted ? { derived: true } : {}),
            },
          });
        }

        if (!attributed) {
          edges.push({
            from: nodeRef(fileNode.id),
            to: target,
            relationship: 'USES',
            evidence: CONFIGURED_EVIDENCE,
            metadata: { via: 'url', host: found.host, line: found.line },
          });
        }
      }
    }

    return {
      nodes: [...nodes.values()],
      edges,
      stats: {
        // The service node is declared here too so its dependency edges resolve
        // without relying on analyzer order; it is not an external service.
        externalServiceCount: [...nodes.values()].filter(
          (node) => node.type === 'external_service',
        ).length,
      },
    };
  }

  /**
   * Places the SDK's imported bindings are constructed or called. An import
   * alone proves a dependency; a use proves where it lives.
   */
  private sdkUses(module: ParsedModule, packageName: string): Array<{ line: number }> {
    const locals = new Set<string>();

    for (const name of localNamesForPackage(module, packageName)) locals.add(name);
    if (locals.size === 0) return [];

    const uses: Array<{ line: number }> = [];

    walk(module.sourceFile, (node) => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const root = rootName(node.expression);
        if (root !== null && locals.has(root)) {
          uses.push({ line: lineOf(module.sourceFile, node) });
        }
      }
    });

    return uses;
  }

  /** Absolute http(s) URLs written in this module, with where they sit. */
  private urlLiterals(
    module: ParsedModule,
  ): Array<{ host: string; line: number; insideCall: boolean }> {
    const found: Array<{ host: string; line: number; insideCall: boolean }> = [];

    walk(module.sourceFile, (node) => {
      if (
        !ts.isStringLiteral(node) &&
        !ts.isNoSubstitutionTemplateLiteral(node) &&
        !ts.isTemplateExpression(node)
      ) {
        return;
      }

      const literal = templateText(node);
      if (!literal) return;

      // Only the part before any interpolation can be trusted as a URL, and a
      // host lives at the front, so this is exactly the useful prefix.
      const host = hostOfUrl(literal.text.split(String.fromCharCode(1))[0] ?? '');
      if (host === null || isPlaceholderHost(host)) return;

      found.push({
        host,
        line: lineOf(module.sourceFile, node),
        insideCall: sitsInsideCall(node),
      });
    });

    return found;
  }
}

function vendorDraft(
  vendor: ExternalServiceVendor,
  evidence: { package?: string; host?: string; known: boolean },
): AnalyzerNodeDraft {
  // A vendor we recognise is one node however it was found: importing the
  // Stripe SDK and calling `api.stripe.com` are two pieces of evidence about
  // the same dependency, not two dependencies. An unrecognised host keys on
  // itself, because that is all we know about it.
  const key = evidence.known
    ? vendor.name.toLowerCase()
    : (evidence.package ?? evidence.host ?? vendor.name);

  const metadata: Record<string, unknown> = { vendor: vendor.name, category: vendor.category };
  if (evidence.package) metadata.package = evidence.package;
  if (evidence.host) metadata.host = evidence.host;

  return {
    type: 'external_service',
    name: vendor.name,
    // No file: one node per vendor endpoint, however many files reach it.
    symbolKey: `external-service:${key}`,
    qualifiedName: key,
    metadata,
  };
}

/** Local names bound to anything imported from a package. */
function localNamesForPackage(module: ParsedModule, packageName: string): string[] {
  const names: string[] = [];

  walk(module.sourceFile, (node) => {
    if (!ts.isIdentifier(node)) return;
    const binding = module.bindings.get(node.text);
    if (binding?.kind === 'package' && binding.packageName === packageName) {
      if (!names.includes(node.text)) names.push(node.text);
    }
  });

  // Locals constructed from those imports: `const stripe = new Stripe(key)`.
  for (const statement of module.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const binding = module.bindings.get(declaration.name.text);
      if (binding?.kind !== 'instance') continue;

      const source = module.bindings.get(binding.className);
      if (source?.kind === 'package' && source.packageName === packageName) {
        names.push(declaration.name.text);
      }
    }
  }

  return names;
}

function rootName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootName(expression.expression);
  return null;
}

/** Whether a literal is an argument of a call, directly or inside an object. */
function sitsInsideCall(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  let hops = 0;

  while (current && hops < 6) {
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) return true;
    if (
      !ts.isObjectLiteralExpression(current) &&
      !ts.isPropertyAssignment(current) &&
      !ts.isTemplateExpression(current) &&
      !ts.isTemplateSpan(current) &&
      !ts.isArrayLiteralExpression(current) &&
      !ts.isBinaryExpression(current) &&
      !ts.isParenthesizedExpression(current)
    ) {
      return false;
    }
    current = current.parent;
    hops += 1;
  }
  return false;
}
