import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEdgeDraft,
  AnalyzerNodeDraft,
  CodeAnalyzer,
  CodeNode,
  NodeReference,
} from '@ckg/graph';
import { draftRef, nodeRef } from '@ckg/graph';
import { classifyFile } from '@ckg/language-detection';
import { evidence, type ConfidenceLevel } from '@ckg/shared';
import {
  endpointLabel,
  isOpenApiDocument,
  normalizeRoutePath,
  parseOpenApi,
  type OpenApiOperation,
  type OpenApiSpec,
} from '../parsers/openapi.js';
import { joinRoutePath } from '../detectors/http.js';
import { ResourceTree } from '../source/resource-file.js';
import { structuredDocumentFor } from '../source/shared.js';

/**
 * The API as it is promised, joined to the API as it is served.
 *
 * A specification is the only artefact in a repository that states the contract
 * the outside world is entitled to. It is also the only one that can be wrong
 * about it — a documented endpoint nobody implemented is a bug, and so is a
 * route nobody documented. Both are findings, and both are only visible if the
 * two are separate nodes that may or may not be linked.
 *
 * That is why an `api_endpoint` is not folded into the existing `api`. `api`
 * means "this repository serves this route, here is the handler"; `api_endpoint`
 * means "this repository promises this operation, here is the line of the
 * specification". Where they agree there is an `IMPLEMENTED_BY` edge, and where
 * they do not the graph can say which side is missing.
 *
 * ## What makes a link
 *
 * An exact match on HTTP method and on the path with its parameter *names*
 * erased: `/users/{id}` and `/users/:id` are the same endpoint in two dialects,
 * and a specification and a controller are allowed to disagree about whether
 * the parameter is called `id` or `userId`. Nothing else counts — not a
 * similar path, not a matching `operationId`, not a controller whose name looks
 * like the tag.
 */

const ANALYZER = 'openapi-analyzer';

const CANDIDATE_SUFFIXES = ['.json', '.yaml', '.yml'] as const;

/** Endpoints read from one specification. A larger one is an API gateway. */
const MAX_OPERATIONS = 500;

export class OpenApiAnalyzer implements CodeAnalyzer {
  readonly name = ANALYZER;
  /**
   * Classification: linking an operation to its handler is reasoning about the
   * graph the source stage built, and the `api` nodes it matches against do not
   * exist until that stage has finished.
   */
  readonly stage: AnalysisStage = 'classification';

  supports(context: AnalysisContext): boolean {
    return context.sources.matching(...CANDIDATE_SUFFIXES).length > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const specs = this.specifications(context);
    if (specs.length === 0) return { stats: { specCount: 0 } };

    const repository = context.symbols.repository();
    const tree = new ResourceTree(repository?.id ?? null, ANALYZER);

    const nodes: AnalyzerNodeDraft[] = [];
    const edges: AnalyzerEdgeDraft[] = [];

    const routes = this.routeIndex(context);

    let operationCount = 0;
    let implementedCount = 0;
    let unimplementedCount = 0;
    let schemaLinkCount = 0;

    for (const spec of specs) {
      const classification = classifyFile(spec.relativePath);
      const specRef = tree.file({
        classification,
        type: 'api_spec',
        metadata: {
          flavour: spec.flavour,
          specVersion: spec.version,
          ...(spec.title !== null ? { title: spec.title } : {}),
          ...(spec.apiVersion !== null ? { apiVersion: spec.apiVersion } : {}),
          ...(spec.basePath !== null ? { basePath: spec.basePath } : {}),
          operationCount: spec.operations.length,
          schemaCount: spec.schemaNames.length,
        },
      });

      for (const operation of spec.operations.slice(0, MAX_OPERATIONS)) {
        operationCount += 1;

        const path = joinRoutePath(spec.basePath, operation.path);
        const label = endpointLabel(operation.method, path);
        const draft = endpointDraft(spec, operation, path, label);
        nodes.push(draft);

        const endpoint = draftRef(draft);

        edges.push({
          from: specRef,
          to: endpoint,
          relationship: 'DEFINES',
          evidence: evidence({
            source: ANALYZER,
            basis: 'declaredInSpec',
            method: 'openapi',
            file: spec.relativePath,
            line: operation.line,
            column: operation.column,
            matched: label,
          }),
          metadata: { httpMethod: operation.method, path },
        });

        const matched = routes.get(routeKey(operation.method, path)) ?? [];
        if (matched.length === 0) {
          unimplementedCount += 1;
        } else {
          implementedCount += 1;
          edges.push(...this.implementations(context, spec, operation, path, label, endpoint, matched));
        }

        schemaLinkCount += this.schemaLinks(context, spec, operation, label, endpoint, edges);
      }
    }

    return {
      nodes: [...tree.nodes(), ...nodes],
      edges: [...tree.edges(), ...edges],
      stats: {
        specCount: specs.length,
        operationCount,
        implementedCount,
        // The headline finding: operations the specification promises and the
        // repository does not serve.
        unimplementedCount,
        schemaLinkCount,
      },
    };
  }

  /**
   * Every API specification in the repository.
   *
   * Detected by content, not by name. A file called `openapi.yaml` that holds a
   * Helm chart is not a specification, and a specification called
   * `contracts/public.yaml` is one — the classifier's guess from the filename
   * is a hint for the scan, and this is the decision.
   */
  private specifications(context: AnalysisContext): OpenApiSpec[] {
    const specs: OpenApiSpec[] = [];

    for (const file of context.sources.matching(...CANDIDATE_SUFFIXES)) {
      const document = structuredDocumentFor(context.sources, file.relativePath);
      if (!document || document.error !== null || !isOpenApiDocument(document)) continue;

      const spec = parseOpenApi(document);
      if (spec) specs.push(spec);
    }

    return specs;
  }

  /**
   * Routes the repository actually serves, keyed by method and shape.
   *
   * Built from the `api` nodes the API analyzer produced, which are the only
   * record of a route that rests on syntax rather than on a name.
   */
  private routeIndex(context: AnalysisContext): Map<string, CodeNode[]> {
    const index = new Map<string, CodeNode[]>();

    for (const node of context.symbols.ofType('api')) {
      const method = node.metadata?.httpMethod;
      const path = node.metadata?.path;
      if (typeof method !== 'string' || typeof path !== 'string') continue;

      const key = routeKey(method, path);
      const existing = index.get(key);
      if (existing) existing.push(node);
      else index.set(key, [node]);
    }

    return index;
  }

  /**
   * `IMPLEMENTED_BY`, from the endpoint to the route and to its handlers.
   *
   * Two altitudes, because two different questions are asked of this edge. The
   * route answers "where is this served"; the handler answers "which code runs".
   * The handler edge inherits the confidence of the `ROUTES_TO` edge it was read
   * from — a handler the API analyzer resolved exactly stays `high`, and one it
   * reached by lifting to the enclosing class stays `medium`. Composing two
   * facts cannot produce something more certain than the weaker of them.
   */
  private implementations(
    context: AnalysisContext,
    spec: OpenApiSpec,
    operation: OpenApiOperation,
    path: string,
    label: string,
    endpoint: NodeReference,
    routes: readonly CodeNode[],
  ): AnalyzerEdgeDraft[] {
    const edges: AnalyzerEdgeDraft[] = [];

    const base = {
      source: ANALYZER,
      method: 'openapi',
      file: spec.relativePath,
      line: operation.line,
      column: operation.column,
      matched: label,
    } as const;

    for (const route of routes) {
      edges.push({
        from: endpoint,
        to: nodeRef(route.id),
        relationship: 'IMPLEMENTED_BY',
        evidence: evidence({ ...base, basis: 'exactRouteMatch' }),
        metadata: {
          via: 'route',
          httpMethod: operation.method,
          path,
          ...(operation.operationId !== null ? { operationId: operation.operationId } : {}),
        },
      });

      for (const hop of context.symbols.edgesFrom(route.id)) {
        if (hop.relationship !== 'ROUTES_TO') continue;

        const handler = context.symbols.node(hop.targetNodeId);
        if (!handler) continue;

        edges.push({
          from: endpoint,
          to: nodeRef(handler.id),
          relationship: 'IMPLEMENTED_BY',
          evidence: evidence({
            ...base,
            basis: confidenceOfHop(hop.metadata) === 'high' ? 'exactRouteMatch' : 'derivedFromContainer',
          }),
          metadata: {
            via: 'handler',
            httpMethod: operation.method,
            path,
            handler: handler.qualifiedName ?? handler.name,
          },
        });
      }
    }

    return edges;
  }

  /**
   * An operation's named schemas, linked to the declarations that carry them.
   *
   * Same uniqueness rule the document analyzer uses, and for the same reason: a
   * schema called `User` and a repository with two classes called `User` is not
   * evidence of anything. One match or none, and `medium` either way, because
   * matching a name is a resolution step however few candidates there were.
   */
  private schemaLinks(
    context: AnalysisContext,
    spec: OpenApiSpec,
    operation: OpenApiOperation,
    label: string,
    endpoint: NodeReference,
    edges: AnalyzerEdgeDraft[],
  ): number {
    const names = new Set([
      ...operation.requestSchemas,
      ...operation.responses.flatMap((response) => response.schemas),
    ]);

    let linked = 0;

    for (const name of [...names].sort()) {
      const match = context.symbols.uniqueDeclaration(name, [
        'class',
        'interface',
        'type',
        'enum',
      ]);
      if (!match) continue;

      linked += 1;
      edges.push({
        from: endpoint,
        to: nodeRef(match.id),
        relationship: 'REFERENCES',
        evidence: evidence({
          source: ANALYZER,
          basis: 'uniqueNameMatch',
          method: 'openapi',
          file: spec.relativePath,
          line: operation.line,
          matched: name,
        }),
        metadata: { schema: name, endpoint: label },
      });
    }

    return linked;
  }
}

function endpointDraft(
  spec: OpenApiSpec,
  operation: OpenApiOperation,
  path: string,
  label: string,
): AnalyzerNodeDraft {
  return {
    type: 'api_endpoint',
    name: label,
    // Scoped to the specification that declares it: two documents promising the
    // same operation are two promises, and a graph that merged them could not
    // say which one a consumer is holding us to.
    symbolKey: `endpoint:${label}`,
    qualifiedName: label,
    filePath: spec.relativePath,
    startLine: operation.line,
    startCharacter: operation.column,
    metadata: {
      httpMethod: operation.method,
      path,
      declaredPath: operation.path,
      ...(operation.operationId !== null ? { operationId: operation.operationId } : {}),
      ...(operation.summary !== null ? { summary: operation.summary } : {}),
      ...(operation.tags.length > 0 ? { tags: operation.tags } : {}),
      ...(operation.parameters.length > 0
        ? {
            parameters: operation.parameters.map((parameter) => ({
              name: parameter.name,
              in: parameter.location,
              required: parameter.required,
            })),
          }
        : {}),
      ...(operation.requestSchemas.length > 0 ? { requestSchemas: operation.requestSchemas } : {}),
      ...(operation.responses.length > 0
        ? { responses: operation.responses.map((response) => response.status) }
        : {}),
      ...(operation.deprecated ? { deprecated: true } : {}),
      specification: spec.relativePath,
    },
  };
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizeRoutePath(path)}`;
}

function confidenceOfHop(metadata: Record<string, unknown> | undefined): ConfidenceLevel {
  const confidence = metadata?.confidence;
  return confidence === 'high' ? 'high' : 'medium';
}
