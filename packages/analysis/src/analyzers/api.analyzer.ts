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
import type { EdgeEvidence } from '@ckg/shared';
import {
  decoratorsOf,
  literalText,
  rangeOf,
  simpleName,
  ts,
  typeReferenceNames,
  walk,
} from '../source/ast.js';
import type { ParsedModule } from '../source/module-set.js';
import {
  resolveCallTarget,
  resolveMember,
  resolveName,
  resolveTypeName,
  resolveValueType,
  stringValue,
  type Resolution,
} from '../source/resolve.js';
import { moduleSetFor } from '../source/shared.js';
import {
  joinRoutePath,
  NEST_ROUTE_DECORATORS,
  ROUTER_METHODS,
  routeLabel,
  type HttpMethod,
} from '../detectors/http.js';

/**
 * HTTP routes, and the handlers they reach.
 *
 * A route is the outside world's entry point into a codebase, which makes it
 * the most useful thing in the graph that no compiler can tell you about. Two
 * shapes are detected, both from syntax that can only mean one thing:
 *
 *   NestJS      `@Controller('/users')` + `@Post()` on a method
 *   Express /   `router.post('/users', handler)` where `router` was created by
 *   Fastify     a factory imported from express or fastify
 *
 * The framework import is part of the evidence, not an afterthought: a class
 * decorated `@Controller` in a file that imports nothing from NestJS is not a
 * NestJS controller, and `thing.get('/x', y)` on an arbitrary object is not a
 * route. Where a handler cannot be resolved to a node, the API node is still
 * emitted — the route exists — and no `ROUTES_TO` edge is invented for it.
 */

const EVIDENCE: EdgeEvidence = { source: 'api-analyzer', confidence: 'high' };
/** Lifting a route to the class that owns its handler is a summary. */
const CONTAINER_EVIDENCE: EdgeEvidence = { source: 'api-analyzer', confidence: 'medium' };

const NEST_PACKAGE_PREFIX = '@nestjs/';

/** Decorators whose parameter type is validated by the framework's pipes. */
const NEST_BODY_DECORATORS = new Set(['Body', 'Query', 'Param']);

interface RouteFinding {
  method: HttpMethod;
  path: string;
  framework: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  /** The node the route dispatches to, when it resolves. */
  handler: CodeNode | undefined;
  /** How the handler was found, for the record. */
  handlerVia: 'decorator' | 'reference' | 'inline' | null;
  guards: CodeNode[];
  validators: CodeNode[];
  metadata: Record<string, unknown>;
}

export class ApiAnalyzer implements CodeAnalyzer {
  readonly name = 'api-analyzer';
  readonly stage: AnalysisStage = 'source';

  supports(context: AnalysisContext): boolean {
    return context.symbols.size > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const modules = moduleSetFor(context.sources);
    const resolution: Resolution = { symbols: context.symbols, modules };

    const parsed = [...modules.modules()];
    const globalPrefix = findGlobalPrefix(parsed);

    const findings: RouteFinding[] = [
      ...this.nestRoutes(resolution, parsed, globalPrefix),
      ...this.routerRoutes(resolution, parsed, globalPrefix),
    ];

    const nodes: AnalyzerNodeDraft[] = [];
    const edges: AnalyzerEdgeDraft[] = [];
    let unresolvedHandlers = 0;

    for (const finding of findings) {
      const draft = apiDraft(finding);
      nodes.push(draft);
      const api = draftRef(draft);

      const fileNode = context.symbols.file(finding.relativePath);
      if (fileNode) {
        edges.push({
          from: nodeRef(fileNode.id),
          to: api,
          relationship: 'CONTAINS',
          evidence: EVIDENCE,
        });
      }

      if (finding.handler) {
        edges.push({
          from: api,
          to: nodeRef(finding.handler.id),
          relationship: 'ROUTES_TO',
          evidence: EVIDENCE,
          metadata: { via: finding.handlerVia },
        });

        // At architecture altitude methods are filtered out, so the route also
        // points at the class that owns the handler.
        const container = context.symbols.enclosingContainer(finding.handler.id);
        if (container) {
          edges.push({
            from: api,
            to: nodeRef(container.id),
            relationship: 'ROUTES_TO',
            evidence: CONTAINER_EVIDENCE,
            metadata: { derived: true },
          });
        }
      } else {
        unresolvedHandlers += 1;
      }

      for (const guard of finding.guards) {
        edges.push({
          from: api,
          to: nodeRef(guard.id),
          relationship: 'AUTHENTICATED_BY',
          evidence: EVIDENCE,
        });
      }

      for (const validator of finding.validators) {
        edges.push({
          from: api,
          to: nodeRef(validator.id),
          relationship: 'VALIDATES',
          evidence: EVIDENCE,
        });
      }
    }

    return {
      nodes,
      edges,
      stats: { routeCount: findings.length, unresolvedHandlerCount: unresolvedHandlers },
    };
  }

  // --- NestJS ------------------------------------------------------------

  private nestRoutes(
    resolution: Resolution,
    modules: readonly ParsedModule[],
    globalPrefix: string | null,
  ): RouteFinding[] {
    const findings: RouteFinding[] = [];

    for (const module of modules) {
      if (!module.bindings.importsFrom((name) => name.startsWith(NEST_PACKAGE_PREFIX))) continue;

      for (const statement of module.sourceFile.statements) {
        if (!ts.isClassDeclaration(statement) || !statement.name) continue;

        const decorators = decoratorsOf(statement);
        const controller = decorators.find((decorator) => decorator.name === 'Controller');
        if (!controller) continue;
        // The decorator must be the framework's, not a local helper that
        // happens to share the name.
        if (!this.isNestDecorator(module, 'Controller')) continue;

        const basePath = controllerPath(resolution, module, controller.arguments[0]);
        const className = statement.name.text;
        const classGuards = this.guardsOf(resolution, module, decorators);

        for (const member of statement.members) {
          if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;

          const memberDecorators = decoratorsOf(member);
          const route = memberDecorators
            .map((decorator) => ({
              decorator,
              method: NEST_ROUTE_DECORATORS.get(decorator.name),
            }))
            .find((candidate) => candidate.method !== undefined);

          if (!route?.method) continue;

          const subPath = stringValue(resolution, module, route.decorator.arguments[0]);
          const range = rangeOf(module.sourceFile, member);
          const methodName = member.name.text;

          const handler = resolution.symbols.member(
            module.relativePath,
            className,
            methodName,
            ['method'],
          );

          findings.push({
            method: route.method,
            path: joinRoutePath(globalPrefix, basePath, subPath),
            framework: 'nestjs',
            relativePath: module.relativePath,
            startLine: range.startLine,
            endLine: range.endLine,
            handler,
            handlerVia: handler ? 'decorator' : null,
            guards: [...classGuards, ...this.guardsOf(resolution, module, memberDecorators)],
            validators: this.validatorsOf(resolution, module, member),
            metadata: {
              controller: className,
              handler: `${className}.${methodName}`,
              ...(globalPrefix ? { globalPrefix } : {}),
            },
          });
        }
      }
    }

    return findings;
  }

  private isNestDecorator(module: ParsedModule, name: string): boolean {
    const binding = module.bindings.get(name);
    if (binding?.kind !== 'package') return false;
    return binding.packageName.startsWith(NEST_PACKAGE_PREFIX);
  }

  /** `@UseGuards(JwtAuthGuard)` — the classes that gate a route. */
  private guardsOf(
    resolution: Resolution,
    module: ParsedModule,
    decorators: ReturnType<typeof decoratorsOf>,
  ): CodeNode[] {
    const guards: CodeNode[] = [];

    for (const decorator of decorators) {
      if (decorator.name !== 'UseGuards') continue;

      for (const argument of decorator.arguments) {
        const name = simpleName(argument);
        if (name === null) continue;
        const node = resolveName(resolution, module, name, ['class']);
        if (node) guards.push(node);
      }
    }

    return guards;
  }

  /**
   * What validates a route's input.
   *
   * Two unambiguous forms: a DTO reached through `@Body()` whose class carries
   * property decorators (class-validator's whole mechanism), and a schema whose
   * `parse` is called in the handler (zod, yup and everything shaped like them).
   */
  private validatorsOf(
    resolution: Resolution,
    module: ParsedModule,
    member: ts.MethodDeclaration,
  ): CodeNode[] {
    const validators: CodeNode[] = [];

    for (const parameter of member.parameters) {
      const decorated = decoratorsOf(parameter).some((decorator) =>
        NEST_BODY_DECORATORS.has(decorator.name),
      );
      if (!decorated) continue;

      for (const typeName of typeReferenceNames(parameter.type)) {
        const node = resolveTypeName(resolution, module, typeName);
        if (node && node.type === 'class' && hasValidationDecorators(module, node.name)) {
          validators.push(node);
        }
      }
    }

    if (member.body) {
      walk(member.body, (node) => {
        if (!ts.isCallExpression(node)) return;
        if (!ts.isPropertyAccessExpression(node.expression)) return;

        const called = node.expression.name.text;
        if (called !== 'parse' && called !== 'safeParse') return;

        const schemaName = simpleName(node.expression.expression);
        if (schemaName === null) return;

        const schema = resolveName(resolution, module, schemaName, ['variable', 'property']);
        if (schema) validators.push(schema);
      });
    }

    return validators;
  }

  // --- Express / Fastify -------------------------------------------------

  private routerRoutes(
    resolution: Resolution,
    modules: readonly ParsedModule[],
    globalPrefix: string | null,
  ): RouteFinding[] {
    // Pass 1: which locals are routers, and what they route.
    const routers = new Map<string, RouterDeclaration>();

    for (const module of modules) {
      for (const declaration of findRouterDeclarations(module)) {
        routers.set(routerKey(module.relativePath, declaration.localName), declaration);
      }
    }

    const routes: Array<{ router: RouterDeclaration; route: RawRoute }> = [];

    for (const module of modules) {
      for (const route of findRouterRoutes(resolution, module, routers)) {
        const router = routers.get(routerKey(module.relativePath, route.routerName));
        if (router) routes.push({ router, route });
      }
    }

    // Pass 2: mounts. `app.use('/users', usersRouter)` prefixes every route of
    // the mounted router, wherever that router was declared.
    const prefixes = resolveMountPrefixes(resolution, modules, routers);

    return routes.map(({ router, route }) => {
      const prefix = prefixes.get(routerKey(router.relativePath, router.localName)) ?? null;
      const handler = route.handler;

      const metadata: Record<string, unknown> = {
        router: router.localName,
        ...(prefix ? { mountedAt: prefix } : {}),
        ...(globalPrefix ? { globalPrefix } : {}),
        ...(route.middlewareCount > 0 ? { middleware: route.middlewareCount } : {}),
      };
      if (handler?.node.qualifiedName) metadata.handler = handler.node.qualifiedName;
      else if (handler?.node.name) metadata.handler = handler.node.name;

      return {
        method: route.method,
        path: joinRoutePath(globalPrefix, prefix, route.path),
        framework: router.framework,
        relativePath: route.relativePath,
        startLine: route.startLine,
        endLine: route.endLine,
        handler: handler?.node,
        handlerVia: handler?.via ?? null,
        guards: [],
        validators: [],
        metadata,
      };
    });
  }
}

// --- router discovery ------------------------------------------------------

interface RouterDeclaration {
  relativePath: string;
  localName: string;
  framework: string;
  /** `router` is mountable; `app` is the server itself. */
  kind: 'router' | 'app';
}

interface RawRoute {
  routerName: string;
  method: HttpMethod;
  path: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  handler: { node: CodeNode; via: 'reference' | 'inline' } | undefined;
  middlewareCount: number;
}

function routerKey(relativePath: string, localName: string): string {
  return `${relativePath}::${localName}`;
}

/**
 * Locals created by a router factory imported from a known framework:
 * `const router = Router()`, `const app = express()`, `const app = fastify()`.
 */
function findRouterDeclarations(module: ParsedModule): RouterDeclaration[] {
  const declarations: RouterDeclaration[] = [];

  walk(module.sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;

    const initializer = node.initializer;
    if (!initializer || !ts.isCallExpression(initializer)) return;

    const calleeName = simpleName(initializer.expression);
    if (calleeName === null) return;

    const rootName = rootNameOf(initializer.expression);
    if (rootName === null) return;

    const binding = module.bindings.get(rootName);
    if (binding?.kind !== 'package') return;

    const framework = frameworkOf(binding.packageName);
    if (framework === null) return;

    const isRouterFactory = calleeName === 'Router' || calleeName === 'router';
    const isAppFactory =
      calleeName === binding.exportedName ||
      calleeName === 'express' ||
      calleeName === 'fastify' ||
      calleeName === 'Fastify';

    if (!isRouterFactory && !isAppFactory) return;

    declarations.push({
      relativePath: module.relativePath,
      localName: node.name.text,
      framework,
      kind: isRouterFactory ? 'router' : 'app',
    });
  });

  return declarations;
}

function frameworkOf(packageName: string): string | null {
  if (packageName === 'express') return 'express';
  if (packageName === 'fastify') return 'fastify';
  return null;
}

function rootNameOf(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootNameOf(expression.expression);
  return null;
}

/** `router.post('/users', handler)` on a known router local. */
function findRouterRoutes(
  resolution: Resolution,
  module: ParsedModule,
  routers: ReadonlyMap<string, RouterDeclaration>,
): RawRoute[] {
  const routes: RawRoute[] = [];

  walk(module.sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isPropertyAccessExpression(node.expression)) return;

    const method = ROUTER_METHODS.get(node.expression.name.text);
    if (!method) return;

    const routerName = ts.isIdentifier(node.expression.expression)
      ? node.expression.expression.text
      : null;
    if (routerName === null) return;
    if (!routers.has(routerKey(module.relativePath, routerName))) return;

    const path = stringValue(resolution, module, node.arguments[0]);
    if (path === null) return;

    const range = rangeOf(module.sourceFile, node);
    const handlers = node.arguments.slice(1);

    routes.push({
      routerName,
      method,
      path,
      relativePath: module.relativePath,
      startLine: range.startLine,
      endLine: range.endLine,
      // The route's handler is its last argument; anything before it is
      // middleware. Earlier arguments are tried only if the last one does not
      // resolve, which covers `(req, res) => controller.create(req.body)`
      // wrappers as well as direct references.
      handler: resolveHandler(resolution, module, handlers),
      // Everything before the last argument is middleware. Counted, not
      // interpreted: what a middleware does is not written at the call site.
      middlewareCount: Math.max(handlers.length - 1, 0),
    });
  });

  return routes;
}

/**
 * Mount prefixes, propagated through nested mounts.
 *
 * `app.use('/api', apiRouter)` and `apiRouter.use('/users', usersRouter)` mean
 * a route declared on `usersRouter` answers at `/api/users/...`. Three rounds
 * of propagation covers the nesting depth real applications use; deeper
 * mounting simply keeps the shallower prefix, which is honest rather than wrong.
 */
function resolveMountPrefixes(
  resolution: Resolution,
  modules: readonly ParsedModule[],
  routers: ReadonlyMap<string, RouterDeclaration>,
): Map<string, string> {
  interface Mount {
    parentKey: string;
    childKey: string;
    path: string;
  }

  const mounts: Mount[] = [];

  for (const module of modules) {
    walk(module.sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (!ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== 'use') return;

      const parentName = ts.isIdentifier(node.expression.expression)
        ? node.expression.expression.text
        : null;
      if (parentName === null) return;

      const parentKey = routerKey(module.relativePath, parentName);
      if (!routers.has(parentKey)) return;

      const path = stringValue(resolution, module, node.arguments[0]);
      if (path === null) return;

      for (const argument of node.arguments.slice(1)) {
        const childKey = mountedRouterKey(resolution, module, argument, routers);
        if (childKey) mounts.push({ parentKey, childKey, path });
      }
    });
  }

  const prefixes = new Map<string, string>();
  for (const mount of mounts) {
    prefixes.set(mount.childKey, joinRoutePath(mount.path));
  }

  for (let round = 0; round < 3; round += 1) {
    for (const mount of mounts) {
      const parentPrefix = prefixes.get(mount.parentKey);
      if (parentPrefix === undefined) continue;

      const combined = joinRoutePath(parentPrefix, mount.path);
      if (prefixes.get(mount.childKey) !== combined) prefixes.set(mount.childKey, combined);
    }
  }

  return prefixes;
}

/**
 * The router a mount argument names.
 *
 * Three forms, in the order they occur in real code: a router declared in this
 * file, a router imported from another, and — the common one in an application
 * with a composition root — a call to a factory that builds and returns one
 * (`app.use('/users', createUserRouter(controller))`). For the factory form the
 * router is the one declared inside the factory's own file; that is only
 * unambiguous when the file declares exactly one, so anything else yields
 * nothing rather than a prefix applied to the wrong routes.
 */
function mountedRouterKey(
  resolution: Resolution,
  module: ParsedModule,
  argument: ts.Expression,
  routers: ReadonlyMap<string, RouterDeclaration>,
): string | null {
  if (ts.isCallExpression(argument)) {
    const calleeName = ts.isIdentifier(argument.expression)
      ? argument.expression.text
      : simpleName(argument.expression);
    if (calleeName === null) return null;

    const binding = module.bindings.get(calleeName);
    const file =
      binding?.kind === 'import'
        ? binding.from
        : binding?.kind === 'local'
          ? module.relativePath
          : null;
    if (file === null) return null;

    return soleRouterIn(routers, file);
  }

  if (!ts.isIdentifier(argument)) return null;

  const local = routerKey(module.relativePath, argument.text);
  if (routers.has(local)) return local;

  const binding = module.bindings.get(argument.text);
  if (binding?.kind !== 'import') return null;

  // The imported name may be an alias; the declaration in the target file is
  // what the router was called there.
  for (const candidate of [binding.exportedName, argument.text]) {
    const key = routerKey(binding.from, candidate);
    if (routers.has(key)) return key;
  }

  // A default export: fall back to the target file's only router.
  void resolution;
  return soleRouterIn(routers, binding.from);
}

/** The key of the one router a file declares, or null if it is not exactly one. */
function soleRouterIn(
  routers: ReadonlyMap<string, RouterDeclaration>,
  relativePath: string,
): string | null {
  const declared = [...routers.values()].filter(
    (declaration) => declaration.relativePath === relativePath && declaration.kind === 'router',
  );

  const only = declared.length === 1 ? declared[0] : undefined;
  return only ? routerKey(only.relativePath, only.localName) : null;
}

/**
 * The node a route dispatches to.
 *
 * Three shapes, each unambiguous: a reference to a method on a value whose
 * class is known, a reference to a function, and an inline wrapper whose body
 * calls one of those. A handler that resolves to none of them yields no edge.
 */
function resolveHandler(
  resolution: Resolution,
  module: ParsedModule,
  handlers: readonly ts.Expression[],
): { node: CodeNode; via: 'reference' | 'inline' } | undefined {
  for (const candidate of [...handlers].reverse()) {
    const expression = unwrapBind(candidate);

    if (ts.isPropertyAccessExpression(expression)) {
      const node = resolveMember(resolution, module, expression);
      if (node) return { node, via: 'reference' };
      continue;
    }

    if (ts.isIdentifier(expression)) {
      const node = resolveName(resolution, module, expression.text, ['function', 'method']);
      if (node) return { node, via: 'reference' };
      continue;
    }

    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      const node = firstResolvableCall(resolution, module, expression);
      if (node) return { node, via: 'inline' };
    }
  }

  return undefined;
}

/** `controller.create.bind(controller)` refers to `controller.create`. */
function unwrapBind(expression: ts.Expression): ts.Expression {
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'bind'
  ) {
    return expression.expression.expression;
  }
  return expression;
}

function firstResolvableCall(
  resolution: Resolution,
  module: ParsedModule,
  fn: ts.ArrowFunction | ts.FunctionExpression,
): CodeNode | undefined {
  let found: CodeNode | undefined;

  walk(fn.body, (node) => {
    if (found) return false;
    if (ts.isCallExpression(node)) {
      const target = resolveCallTarget(resolution, module, node);
      if (target) found = target;
    }
    return true;
  });

  return found;
}

// --- shared helpers --------------------------------------------------------

/** `app.setGlobalPrefix('api')` — NestJS's repository-wide route prefix. */
function findGlobalPrefix(modules: readonly ParsedModule[]): string | null {
  for (const module of modules) {
    let found: string | null = null;

    walk(module.sourceFile, (node) => {
      if (found !== null) return false;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'setGlobalPrefix'
      ) {
        found = literalText(node.arguments[0]);
      }
      return true;
    });

    if (found !== null) return found;
  }
  return null;
}

/** `@Controller('/users')` or `@Controller({ path: 'users' })`. */
function controllerPath(
  resolution: Resolution,
  module: ParsedModule,
  argument: ts.Expression | undefined,
): string | null {
  if (!argument) return null;

  const value = stringValue(resolution, module, argument);
  if (value !== null) return value;

  if (ts.isObjectLiteralExpression(argument)) {
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (simpleName(property.name as ts.Expression) !== 'path') continue;
      return stringValue(resolution, module, property.initializer);
    }
  }
  return null;
}

/** Whether a class's properties carry decorators, as class-validator requires. */
function hasValidationDecorators(module: ParsedModule, className: string): boolean {
  for (const statement of module.sourceFile.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    if (statement.name?.text !== className) continue;

    return statement.members.some((member) => decoratorsOf(member).length > 0);
  }
  return false;
}

function apiDraft(finding: RouteFinding): AnalyzerNodeDraft {
  const label = routeLabel(finding.method, finding.path);

  return {
    type: 'api',
    name: label,
    // Identity is the route itself: the same method and path declared twice is
    // one API, however many files mention it.
    symbolKey: `api:${label}`,
    qualifiedName: label,
    filePath: finding.relativePath,
    startLine: finding.startLine,
    endLine: finding.endLine,
    metadata: {
      httpMethod: finding.method,
      path: finding.path,
      framework: finding.framework,
      ...finding.metadata,
    },
  };
}

export { resolveCallTarget, resolveMember, resolveValueType };
export type { NodeReference };
