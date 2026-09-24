import { lineOf, literalText, ts } from '../source/ast.js';
import { normalizeTableIdentifier, type SqlAccess } from './sql.js';

/**
 * Table access written with the Kysely query builder.
 *
 *   db.selectFrom('album')   db.insertInto('album')   db.updateTable('asset')
 *
 * A detector, not an analyzer: it produces the same (table, read/write,
 * statement, location) facts the SQL detector reads out of string literals,
 * and the database analyzer turns them into the same table nodes and the same
 * READS_FROM / WRITES_TO edges. Nothing downstream can tell which detector a
 * relationship came from except `metadata.detector`.
 *
 * **Literal names only.** A table named by a variable, a call or an
 * interpolated template produces nothing — a missed edge is recoverable by
 * reading the code, a wrong one is believed.
 *
 * **CTE names are query-scoped.** `with('album', …)` introduces a name that
 * shadows the table `album` for the rest of *that* query — and only there. So
 * scope follows the builder chain: a CTE name enters scope after its `with`
 * link (for `withRecursive`, before its own body), is visible to later links
 * and to subqueries built inside their arguments, and is never visible to an
 * unrelated query elsewhere in the file. Inside a non-recursive CTE's own body
 * the name still means the physical table, which is exactly Immich's
 * `.with('album', (db) => db.insertInto('album'))`. A builder carried through a
 * variable keeps the CTE names it was assigned with, within the same function.
 * When a CTE name cannot be read — a variable — every table reference that
 * could be shadowed by it is skipped rather than guessed at.
 */

export interface KyselyTableAccess {
  table: string;
  access: SqlAccess;
  /** The SQL statement the call builds, in the SQL detector's vocabulary. */
  statement: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'JOIN';
  line: number;
  column: number;
  /**
   * The lines of the declaration the access is written in — the method,
   * function or function-valued variable, never an anonymous callback inside
   * it. The analyzer attributes the access to the graph node spanning exactly
   * these lines, so a same-line symbol the indexer happens to emit (the
   * shorthand property in `.set({ name })`) cannot claim it. Null at the top
   * level of a module.
   */
  declaration: { startLine: number; endLine: number } | null;
}

export interface KyselyScan {
  accesses: KyselyTableAccess[];
  /** Literal names that resolved to a CTE in scope, and so are not tables. */
  cteReferences: number;
  /** Table arguments that were not a literal: a variable, a call, a template. */
  dynamicReferences: number;
  /** Literal names skipped because an unreadable CTE name might shadow them. */
  undetermined: number;
}

/**
 * The builder methods whose first argument is a physical table, and what the
 * call does to it. Chosen from what real code uses, not from Kysely's whole
 * API: `.from`, `.table` and `.using` also take strings, but in practice mean
 * UPDATE…FROM, a row reference to a table already in scope, or an index method,
 * and none of those is safely a table access on its own.
 */
const TABLE_METHODS: ReadonlyMap<string, { access: SqlAccess; statement: KyselyTableAccess['statement'] }> =
  new Map([
    ['selectFrom', { access: 'read', statement: 'SELECT' }],
    ['insertInto', { access: 'write', statement: 'INSERT' }],
    ['updateTable', { access: 'write', statement: 'UPDATE' }],
    ['deleteFrom', { access: 'write', statement: 'DELETE' }],
    ['innerJoin', { access: 'read', statement: 'JOIN' }],
    ['leftJoin', { access: 'read', statement: 'JOIN' }],
    ['crossJoin', { access: 'read', statement: 'JOIN' }],
  ]);

const CTE_METHODS = new Set(['with', 'withRecursive']);

/** `'album as a'`: the alias names the table only inside this query. */
const ALIAS = /\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i;

interface Scope {
  /** CTE names visible at this point of the query. */
  readonly ctes: ReadonlySet<string>;
  /** True once an unreadable CTE name is in scope: nothing can be classified. */
  readonly unknown: boolean;
  /** CTE names carried by builder variables in the enclosing functions. */
  readonly carried: ReadonlyMap<string, CarriedCtes>;
}

interface CarriedCtes {
  names: Set<string>;
  unknown: boolean;
}

interface Link {
  name: string;
  call: ts.CallExpression;
}

const EMPTY_SCOPE: Scope = { ctes: new Set(), unknown: false, carried: new Map() };

export function findKyselyTableAccesses(sourceFile: ts.SourceFile): KyselyScan {
  const result: KyselyScan = { accesses: [], cteReferences: 0, dynamicReferences: 0, undetermined: 0 };

  const visit = (node: ts.Node, scope: Scope): void => {
    if (isFunctionLike(node)) {
      scope = { ...scope, carried: carriedCtesIn(node, scope.carried) };
    }

    // Reached top-down, the first call with a property-access callee is the
    // outermost link of its chain. A chain with a Kysely link is handled whole;
    // anything else is descended into for the chains inside it.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrap(node.expression))) {
      const { root, links } = chainOf(node);
      if (links.some((link) => TABLE_METHODS.has(link.name) || CTE_METHODS.has(link.name))) {
        chain(root, links, scope);
        return;
      }
    }

    node.forEachChild((child) => visit(child, scope));
  };

  const chain = (root: ts.Expression, links: Link[], outer: Scope): void => {
    visit(root, outer);

    // A builder read from a variable carries the CTEs it was built with.
    const carried = ts.isIdentifier(root) ? outer.carried.get(root.text) : undefined;
    const ctes = new Set([...outer.ctes, ...(carried?.names ?? [])]);
    let unknown = outer.unknown || (carried?.unknown ?? false);
    const current = (): Scope => ({ ctes, unknown, carried: outer.carried });

    for (const link of links) {
      const args = link.call.arguments;

      if (CTE_METHODS.has(link.name)) {
        const name = cteName(args[0]);
        const recursive = link.name === 'withRecursive';
        if (recursive && name !== null) ctes.add(name);
        // A non-recursive CTE's body cannot see its own name: there, the name
        // is still the physical table.
        for (const argument of args.slice(1)) visit(argument, current());
        if (name === null) unknown = true;
        else ctes.add(name);
        continue;
      }

      const table = TABLE_METHODS.get(link.name);
      if (table) {
        record(args[0], table, current());
        for (const argument of args.slice(1)) visit(argument, current());
        continue;
      }

      for (const argument of args) visit(argument, current());
    }
  };

  const record = (
    argument: ts.Expression | undefined,
    table: { access: SqlAccess; statement: KyselyTableAccess['statement'] },
    scope: Scope,
  ): void => {
    if (!argument) return;

    // `selectFrom(['asset', 'album'])`: several tables, each read the same way.
    if (ts.isArrayLiteralExpression(argument) && table.statement === 'SELECT') {
      for (const element of argument.elements) record(element, table, scope);
      return;
    }

    const literal = literalText(argument);
    if (literal === null) {
      result.dynamicReferences += 1;
      // A subquery or callback in the table position may itself build queries.
      visit(argument, scope);
      return;
    }

    const name = normalizeTableIdentifier(literal.replace(ALIAS, '').trim());
    if (name === null) {
      result.dynamicReferences += 1;
      return;
    }
    if (scope.ctes.has(name)) {
      result.cteReferences += 1;
      return;
    }
    if (scope.unknown) {
      result.undetermined += 1;
      return;
    }

    const position = sourceFile.getLineAndCharacterOfPosition(argument.getStart(sourceFile));
    const declaration = enclosingDeclaration(argument);
    result.accesses.push({
      table: name,
      access: table.access,
      statement: table.statement,
      line: lineOf(sourceFile, argument),
      column: position.character,
      declaration: declaration
        ? {
            startLine: lineOf(sourceFile, declaration),
            endLine: sourceFile.getLineAndCharacterOfPosition(declaration.getEnd()).line + 1,
          }
        : null,
    });
  };

  visit(sourceFile, EMPTY_SCOPE);
  return result;
}

/** A chain's links from its root outwards: `db.selectFrom(…).where(…)` → selectFrom, where. */
function chainOf(outermost: ts.CallExpression): { root: ts.Expression; links: Link[] } {
  const links: Link[] = [];
  let node: ts.Expression = outermost;

  for (;;) {
    const current = unwrap(node);
    if (!ts.isCallExpression(current)) {
      node = current;
      break;
    }
    const callee = unwrap(current.expression);
    if (!ts.isPropertyAccessExpression(callee)) {
      node = current;
      break;
    }
    links.push({ name: callee.name.text, call: current });
    node = callee.expression;
  }

  return { root: unwrap(node), links: links.reverse() };
}

/** `'album'`, or `'album(id, name)'` with the column list; null when not a literal. */
function cteName(argument: ts.Expression | undefined): string | null {
  const literal = literalText(argument);
  if (literal === null) return null;
  const name = literal.split('(')[0]?.trim() ?? '';
  return normalizeTableIdentifier(name);
}

/**
 * CTE names each builder variable of a function was given: `let query =
 * db.with('x', …)`, `query = query.with('y', …)`, `(query as any) = …`.
 * Collected over the whole function, which can only over-include — and an
 * extra CTE name in scope can only suppress an edge, never invent one.
 */
function carriedCtesIn(
  fn: ts.Node,
  inherited: ReadonlyMap<string, CarriedCtes>,
): ReadonlyMap<string, CarriedCtes> {
  const carried = new Map<string, CarriedCtes>(
    [...inherited].map(([name, value]) => [name, { names: new Set(value.names), unknown: value.unknown }]),
  );

  const note = (target: ts.Expression | ts.BindingName, value: ts.Expression): void => {
    const variable = unwrap(target as ts.Expression);
    if (!ts.isIdentifier(variable)) return;
    const names = cteNamesIn(value);
    if (names.names.size === 0 && !names.unknown) return;
    const entry = carried.get(variable.text) ?? { names: new Set<string>(), unknown: false };
    for (const name of names.names) entry.names.add(name);
    entry.unknown ||= names.unknown;
    carried.set(variable.text, entry);
  };

  const scan = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer) note(node.name, node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      note(node.left, node.right);
    }
    node.forEachChild(scan);
  };
  scan(fn);

  return carried;
}

/** The CTE names a builder expression's own chain introduces. */
function cteNamesIn(expression: ts.Expression): { names: Set<string>; unknown: boolean } {
  const names = new Set<string>();
  let unknown = false;
  const value = unwrap(expression);
  if (!ts.isCallExpression(value)) return { names, unknown };

  // `query.with(…)` extends whatever `query` already carried; the caller merges.
  for (const link of chainOf(value).links) {
    if (!CTE_METHODS.has(link.name)) continue;
    const name = cteName(link.call.arguments[0]);
    if (name === null) unknown = true;
    else names.add(name);
  }
  return { names, unknown };
}

/**
 * The nearest named declaration around a node: a method, function,
 * constructor or accessor, or a variable or class property whose value is a
 * function. Callbacks passed to builder methods are skipped — they belong to
 * the declaration that builds the query.
 */
function enclosingDeclaration(node: ts.Node): ts.Node | null {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isMethodDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
    if (
      (ts.isVariableDeclaration(current) || ts.isPropertyDeclaration(current)) &&
      current.initializer &&
      (ts.isArrowFunction(unwrap(current.initializer)) || ts.isFunctionExpression(unwrap(current.initializer)))
    ) {
      return current;
    }
  }
  return null;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}
