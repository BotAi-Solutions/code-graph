import ts from 'typescript';
import type { SourceFile as CkgSourceFile } from '@ckg/graph';

/**
 * TypeScript AST helpers.
 *
 * Parsing rather than pattern-matching text is the whole basis for the evidence
 * quality the graph promises: `@Controller('/users')` inside a comment or a
 * string is not a controller, and a regex cannot tell the difference. The
 * compiler's own parser can, so we use it — syntax only, no type checker, so a
 * repository whose dependencies are not installed still analyses.
 */

/** Positions as the graph records them: 1-based lines, 0-based characters. */
export interface SourceRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
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

export const TYPESCRIPT_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts'] as const;
export const JAVASCRIPT_SUFFIXES = ['.js', '.jsx', '.mjs', '.cjs'] as const;

export function isAnalysableModule(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith('.d.ts')) return false;
  return [...TYPESCRIPT_SUFFIXES, ...JAVASCRIPT_SUFFIXES].some((suffix) => lower.endsWith(suffix));
}

export function parseModule(file: CkgSourceFile): ts.SourceFile {
  const suffix = SCRIPT_KIND_BY_SUFFIX.find(([candidate]) =>
    file.relativePath.toLowerCase().endsWith(candidate),
  );

  return ts.createSourceFile(
    file.relativePath,
    file.text,
    // Latest, because we only ever parse: a target that rejects newer syntax
    // would silently lose findings in a modern repository.
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    suffix?.[1] ?? ts.ScriptKind.TS,
  );
}

export function rangeOf(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  return {
    startLine: start.line + 1,
    startCharacter: start.character,
    endLine: end.line + 1,
    endCharacter: end.character,
  };
}

export function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Depth-first walk. A visitor returning `false` skips that node's children. */
export function walk(node: ts.Node, visit: (node: ts.Node) => boolean | void): void {
  const descend = visit(node);
  if (descend === false) return;
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

export interface DecoratorUse {
  /** Decorator name as written: `Controller` in `@Controller('/users')`. */
  name: string;
  arguments: readonly ts.Expression[];
  node: ts.Decorator;
}

/** Decorators on a declaration, in source order. Empty when it has none. */
export function decoratorsOf(node: ts.Node): DecoratorUse[] {
  if (!ts.canHaveDecorators(node)) return [];

  const decorators = ts.getDecorators(node);
  if (!decorators) return [];

  const uses: DecoratorUse[] = [];

  for (const decorator of decorators) {
    const expression = decorator.expression;

    if (ts.isCallExpression(expression)) {
      const name = simpleName(expression.expression);
      if (name) uses.push({ name, arguments: expression.arguments, node: decorator });
      continue;
    }

    const name = simpleName(expression);
    if (name) uses.push({ name, arguments: [], node: decorator });
  }

  return uses;
}

/** The leading identifier of an expression: `Foo` in `Foo.bar.baz`. */
export function rootIdentifier(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;

  for (let guard = 0; guard < 64; guard += 1) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return null;
  }
  return null;
}

/** The trailing name of a property access: `baz` in `foo.bar.baz`. */
export function simpleName(expression: ts.Expression | ts.EntityName): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isQualifiedName(expression)) return expression.right.text;
  return null;
}

/** Dotted text of a property-access chain: `this.repository.findById`. */
export function accessPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';

  if (ts.isPropertyAccessExpression(expression)) {
    const left = accessPath(expression.expression);
    return left === null ? null : `${left}.${expression.name.text}`;
  }
  return null;
}

/**
 * The literal text of a string expression, when it has one. A template literal
 * counts only when it has no substitutions; whether it was interpolated is
 * reported because that is exactly what separates a high-confidence finding
 * from a medium one.
 */
export function literalText(expression: ts.Node | undefined): string | null {
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  return null;
}

const SUBSTITUTION_MARK = String.fromCharCode(1);

/**
 * Text of a string or template literal, with substitutions replaced by a marker
 * that no identifier can contain — so a pattern can still be matched across the
 * literal parts without ever matching *through* an interpolation.
 */
export function templateText(
  expression: ts.Node,
): { text: string; interpolated: boolean } | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { text: expression.text, interpolated: false };
  }
  if (ts.isTemplateExpression(expression)) {
    const parts = [
      expression.head.text,
      ...expression.templateSpans.map((span) => `${SUBSTITUTION_MARK}${span.literal.text}`),
    ];
    return { text: parts.join(''), interpolated: true };
  }
  return null;
}

export { SUBSTITUTION_MARK };

/**
 * Names of the types a type annotation mentions, unwrapping the containers, so
 * the useful name in `Promise<User[]>` or `HttpResponse<User>` is `User`.
 */
export function typeReferenceNames(type: ts.TypeNode | undefined): string[] {
  if (!type) return [];

  const names: string[] = [];

  const visit = (node: ts.TypeNode): void => {
    if (ts.isTypeReferenceNode(node)) {
      const name = simpleName(node.typeName);
      if (name) names.push(name);
      for (const argument of node.typeArguments ?? []) visit(argument);
      return;
    }
    if (ts.isArrayTypeNode(node)) {
      visit(node.elementType);
      return;
    }
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      for (const member of node.types) visit(member);
      return;
    }
    if (ts.isParenthesizedTypeNode(node)) {
      visit(node.type);
    }
  };

  visit(type);
  return names;
}

/** The class declaration a node sits inside, if any. */
export function enclosingClass(node: ts.Node): ts.ClassDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current)) return current;
    current = current.parent;
  }
  return null;
}

export { ts };
