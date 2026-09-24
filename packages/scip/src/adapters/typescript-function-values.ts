import ts from 'typescript';
import type { ScipFunctionValue } from '../types/index.js';

/**
 * Finds the two facts about functions that SCIP does not record:
 *
 * - which variables are declared *as* functions, and
 * - which occurrences of a name are the callee of a call.
 *
 * scip-typescript reports `export const f = () => {}` as a plain variable, so
 * the graph cannot tell a helper from a constant. It also gives every
 * occurrence of `f` the same role, so `f()` and `register(f)` look alike.
 *
 * Both answers come from the syntax tree alone, with no type checker. That
 * keeps them cheap, and keeps them available when the repository's
 * dependencies are not installed. The rules are deliberately narrow:
 *
 * - A declaration counts only when it is a `const` binding a single name to an
 *   arrow function or a function expression, optionally in parentheses. A value
 *   that merely turns out to be callable (`const f = makeHandler()`,
 *   `const f = g as Handler`) does not count. Neither does `let` or `var`,
 *   which can be reassigned to anything.
 * - A call is a call expression whose callee is a bare name (`f()`,
 *   `await f()`, `f?.()`, `f<T>()`) or the property name of a member access
 *   (`ns.f()`). In `a.b()` only `b` is called, not `a`. `new f()`, tagged
 *   templates and `f.call()` are not calls of `f`.
 */

export interface FunctionValueScan {
  /** Position of each declared name that holds a function, and how it was written. */
  declarations: Map<string, ScipFunctionValue>;
  /** Positions of the names that are the callee of a call expression. */
  callees: Set<string>;
}

/** The key both maps use: a zero-based line and character, as SCIP records them. */
export function positionKey(line: number, character: number): string {
  return `${String(line)}:${String(character)}`;
}

const SCRIPT_KIND_BY_SUFFIX: ReadonlyArray<[string, ts.ScriptKind]> = [
  ['.tsx', ts.ScriptKind.TSX],
  ['.jsx', ts.ScriptKind.JSX],
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
];

export function scanFunctionValues(relativePath: string, text: string): FunctionValueScan {
  const lower = relativePath.toLowerCase();
  const scriptKind =
    SCRIPT_KIND_BY_SUFFIX.find(([suffix]) => lower.endsWith(suffix))?.[1] ?? ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind,
  );

  const declarations = new Map<string, ScipFunctionValue>();
  const callees = new Set<string>();

  const keyOf = (node: ts.Node): string => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return positionKey(position.line, position.character);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && isConst(node)) {
      for (const declaration of node.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const kind = functionValueOf(declaration.initializer);
        if (kind) declarations.set(keyOf(declaration.name), kind);
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee) callees.add(keyOf(callee));
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { declarations, callees };
}

/** `const` only: `let`, `var`, `using` and `await using` are excluded. */
function isConst(list: ts.VariableDeclarationList): boolean {
  return (list.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
}

function functionValueOf(initializer: ts.Expression): ScipFunctionValue | null {
  const expression = unwrapParentheses(initializer);
  if (ts.isArrowFunction(expression)) return 'arrow-function';
  if (ts.isFunctionExpression(expression)) return 'function-expression';
  return null;
}

function calleeName(expression: ts.Expression): ts.Identifier | null {
  let callee = unwrapParentheses(expression);
  while (ts.isNonNullExpression(callee)) callee = unwrapParentheses(callee.expression);

  if (ts.isIdentifier(callee)) return callee;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name;
  return null;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}
