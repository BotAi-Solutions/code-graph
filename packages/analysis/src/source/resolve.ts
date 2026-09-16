import type { CodeNode, CodeNodeType, SymbolIndex } from '@ckg/graph';
import ts from 'typescript';
import { accessPath, literalText, rootIdentifier, simpleName } from './ast.js';
import type { Binding } from './bindings.js';
import type { ModuleSet, ParsedModule } from './module-set.js';

/**
 * Turning a name in the source into a node in the graph.
 *
 * Everything here goes through the binding table, so a name only ever resolves
 * to the declaration it actually refers to. There is deliberately no fallback
 * that searches the repository for a matching name: an unresolvable reference
 * returns `undefined`, the caller emits no edge, and the graph stays free of
 * relationships that exist only because two identifiers looked alike.
 */

export interface Resolution {
  symbols: SymbolIndex;
  modules: ModuleSet;
}

const TYPE_LIKE: readonly CodeNodeType[] = ['class', 'interface', 'type', 'enum'];
const CALLABLE_LIKE: readonly CodeNodeType[] = ['function', 'method'];

/** The node a name used in `module` refers to, following imports one hop. */
export function resolveName(
  resolution: Resolution,
  module: ParsedModule,
  name: string,
  types?: readonly CodeNodeType[],
): CodeNode | undefined {
  const binding = module.bindings.get(name);

  if (binding?.kind === 'import') {
    return resolveExport(resolution, binding.from, binding.exportedName, name, types);
  }
  if (binding?.kind === 'package' || binding?.kind === 'builtin') return undefined;

  // Declared here, or not a binding at all (a global): the file itself is the
  // only place it can legitimately resolve.
  return resolution.symbols.declaration(module.relativePath, name, types);
}

/** The node a file exports under a name, following one level of re-export. */
export function resolveExport(
  resolution: Resolution,
  relativePath: string,
  exportedName: string,
  localAlias: string,
  types?: readonly CodeNodeType[],
): CodeNode | undefined {
  // `default` and `*` do not name a declaration; the local alias is the best
  // available handle on it.
  const candidates =
    exportedName === 'default' || exportedName === '*'
      ? [localAlias, exportedName]
      : [exportedName, localAlias];

  for (const candidate of candidates) {
    const direct = resolution.symbols.declaration(relativePath, candidate, types);
    if (direct) return direct;
  }

  const target = resolution.modules.module(relativePath);
  if (!target) return undefined;

  for (const reexport of target.bindings.reexported()) {
    if (reexport.exportedName !== exportedName) continue;
    const node = resolution.symbols.declaration(reexport.from, reexport.localName, types);
    if (node) return node;
  }

  // Imported into the target file and re-exported from there.
  const binding = target.bindings.get(exportedName);
  if (binding?.kind === 'import') {
    return resolution.symbols.declaration(binding.from, binding.exportedName, types);
  }

  return undefined;
}

/**
 * The class or interface behind a value expression.
 *
 * `this.repository` resolves through the field's declared type or its
 * `new UserRepository()` initialiser; `controller` through the local's; and a
 * bare `UserService` through the import that brought it in.
 */
export function resolveValueType(
  resolution: Resolution,
  module: ParsedModule,
  expression: ts.Expression,
): CodeNode | undefined {
  const path = accessPath(expression);
  const binding =
    (path !== null ? module.bindings.get(path) : undefined) ??
    module.bindings.forExpression(expression);

  return resolveBindingType(resolution, module, binding);
}

function resolveBindingType(
  resolution: Resolution,
  module: ParsedModule,
  binding: Binding | undefined,
  depth = 0,
): CodeNode | undefined {
  if (!binding || depth > 4) return undefined;

  switch (binding.kind) {
    case 'instance':
      return resolveName(resolution, module, binding.className, TYPE_LIKE);
    case 'import':
      return resolveExport(
        resolution,
        binding.from,
        binding.exportedName,
        binding.exportedName,
        TYPE_LIKE,
      );
    case 'local':
      return resolution.symbols.declaration(module.relativePath, binding.declaredName, TYPE_LIKE);
    case 'call':
      return resolveBindingType(resolution, module, binding.callee ?? undefined, depth + 1);
    case 'package':
    case 'builtin':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The function or method a call expression invokes.
 *
 * Handles the three shapes that actually matter: a call on a field or local
 * whose type is known (`this.service.create(...)`), a static call on an
 * imported class (`UserService.create(...)`), and a plain call to a function
 * (`createUser(...)`).
 */
export function resolveCallTarget(
  resolution: Resolution,
  module: ParsedModule,
  call: ts.CallExpression,
): CodeNode | undefined {
  const callee = call.expression;

  if (ts.isPropertyAccessExpression(callee)) {
    const memberName = callee.name.text;
    const owner = resolveValueType(resolution, module, callee.expression);
    if (!owner?.filePath) return undefined;

    return resolution.symbols.member(owner.filePath, owner.name, memberName, CALLABLE_LIKE);
  }

  if (ts.isIdentifier(callee)) {
    return resolveName(resolution, module, callee.text, CALLABLE_LIKE);
  }

  return undefined;
}

/** The member of a class named by `owner.member`, when the owner resolves. */
export function resolveMember(
  resolution: Resolution,
  module: ParsedModule,
  expression: ts.Expression,
  types: readonly CodeNodeType[] = CALLABLE_LIKE,
): CodeNode | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;

  const owner = resolveValueType(resolution, module, expression.expression);
  if (!owner?.filePath) return undefined;

  return resolution.symbols.member(owner.filePath, owner.name, expression.name.text, types);
}

/** The node a type annotation refers to, for ACCEPTS and RETURNS edges. */
export function resolveTypeName(
  resolution: Resolution,
  module: ParsedModule,
  typeName: string,
): CodeNode | undefined {
  return resolveName(resolution, module, typeName, TYPE_LIKE);
}

/**
 * The string an expression evaluates to, when that is knowable without running
 * anything: a literal, a module constant, or a constant imported from another
 * file in this repository.
 *
 * `events.emit(USER_CREATED, user)` names an event as surely as
 * `events.emit('user.created', user)` does, and a codebase that declares its
 * event names in one place should not be the one the graph understands less
 * well. Resolution follows at most one import hop and never guesses.
 */
export function stringValue(
  resolution: Resolution,
  module: ParsedModule,
  expression: ts.Expression | undefined,
): string | null {
  if (!expression) return null;

  const literal = literalText(expression);
  if (literal !== null) return literal;

  if (!ts.isIdentifier(expression)) return null;

  const own = module.bindings.constant(expression.text);
  if (own !== undefined) return own;

  const binding = module.bindings.get(expression.text);
  if (binding?.kind !== 'import') return null;

  const target = resolution.modules.module(binding.from);
  if (!target) return null;

  const names =
    binding.exportedName === 'default' || binding.exportedName === '*'
      ? [expression.text]
      : [binding.exportedName, expression.text];

  for (const name of names) {
    const value = target.bindings.constant(name);
    if (value !== undefined) return value;
  }
  return null;
}

/** The definition a position sits inside, at member altitude. */
export function enclosingDefinition(
  resolution: Resolution,
  relativePath: string,
  line: number,
): CodeNode | undefined {
  return resolution.symbols.enclosingDefinition(relativePath, line);
}

/**
 * The pair of nodes a syntactic finding should attach to: the definition it
 * sits inside, and the class that owns that definition.
 *
 * Architectural edges are emitted at both altitudes on purpose — a SQL
 * statement inside `UserRepository.create` is a fact about the method and a
 * fact about the repository class — and the container edge is what makes the
 * architecture projection readable.
 */
export interface Attribution {
  definition: CodeNode | undefined;
  container: CodeNode | undefined;
}

export function attribute(
  resolution: Resolution,
  relativePath: string,
  line: number,
): Attribution {
  const definition = resolution.symbols.enclosingDefinition(relativePath, line);
  if (!definition) {
    return { definition: undefined, container: undefined };
  }

  if (definition.type === 'class' || definition.type === 'interface') {
    return { definition, container: definition };
  }

  return {
    definition,
    container: resolution.symbols.enclosingContainer(definition.id),
  };
}

export { simpleName, rootIdentifier };
