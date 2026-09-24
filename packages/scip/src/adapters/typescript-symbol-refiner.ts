import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SupportedLanguage } from '@ckg/shared';
import type { ScipDocument, ScipIndex, ScipSymbol, ScipSymbolKind } from '../types/index.js';
import type { RefineContext, ScipSymbolRefiner } from './symbol-refiner.js';
import { positionKey, scanFunctionValues, type FunctionValueScan } from './typescript-function-values.js';

/**
 * Recovers TypeScript/JavaScript declaration kinds that SCIP does not carry.
 *
 * Every definition has an exact range, so the declaring keyword is whatever
 * precedes the name on that line (`export interface Foo`, `type Bar =`,
 * `class Baz`, ...). Reading that one token is enough to turn a generic
 * "class" into interface / enum / type-alias, which in turn is what makes
 * IMPLEMENTS and EXTENDS distinguishable downstream.
 *
 * It also parses each file once to recover what the keyword cannot show: a
 * `const` whose value is a function becomes a `function` (see
 * `typescript-function-values.ts`), and each occurrence that is the callee of
 * a call is marked `isCall`. Without that, a call to `const f = () => {}`
 * could not be told apart from passing `f` as a value.
 *
 * No source text is retained, logged or written to the graph.
 */

const KEYWORD_TO_KIND: ReadonlyMap<string, ScipSymbolKind> = new Map<string, ScipSymbolKind>([
  ['interface', 'interface'],
  ['class', 'class'],
  ['enum', 'enum'],
  ['type', 'type'],
  ['function', 'function'],
  ['namespace', 'namespace'],
  ['module', 'module'],
  ['const', 'constant'],
  ['get', 'accessor'],
  ['set', 'accessor'],
]);

/** Modifiers that may sit between the declaring keyword and the name. */
const SKIPPABLE_MODIFIERS = new Set([
  'export',
  'default',
  'declare',
  'abstract',
  'async',
  'static',
  'readonly',
  'public',
  'private',
  'protected',
  'override',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class TypeScriptSymbolRefiner implements ScipSymbolRefiner {
  readonly name = 'typescript';

  supports(language: SupportedLanguage): boolean {
    return language === 'typescript' || language === 'javascript';
  }

  async refine(index: ScipIndex, context: RefineContext): Promise<ScipIndex> {
    const documents = await Promise.all(
      index.documents.map((document) => this.refineDocument(document, context)),
    );
    return { ...index, documents };
  }

  private async refineDocument(
    document: ScipDocument,
    context: RefineContext,
  ): Promise<ScipDocument> {
    const text = await this.readText(path.join(context.repositoryPath, document.relativePath));
    if (text === null) return document;
    const lines = text.split('\n');
    const scan = scanFunctionValues(document.relativePath, text);

    // Definition occurrence per symbol, so we know where to look.
    const definitionLine = new Map<string, { line: number; character: number }>();
    for (const occurrence of document.occurrences) {
      if (!occurrence.isDefinition) continue;
      if (definitionLine.has(occurrence.symbolId)) continue;
      definitionLine.set(occurrence.symbolId, {
        line: occurrence.startLine,
        character: occurrence.startCharacter,
      });
    }

    const symbols = document.symbols.map((symbol) => {
      const position = definitionLine.get(symbol.id);
      if (!position) return symbol;

      const line = lines[position.line];
      if (line === undefined) return symbol;

      const keyword = declaringKeyword(line, position.character);
      const refined = keyword ? KEYWORD_TO_KIND.get(keyword) : undefined;
      const byKeyword = refined ? applyKind(symbol, refined) : symbol;

      return applyFunctionValue(byKeyword, scan, position);
    });

    const occurrences = document.occurrences.map((occurrence) =>
      !occurrence.isDefinition &&
      scan.callees.has(positionKey(occurrence.startLine, occurrence.startCharacter))
        ? { ...occurrence, isCall: true }
        : occurrence,
    );

    return { ...document, symbols, occurrences };
  }

  private async readText(filePath: string): Promise<string | null> {
    try {
      const contents = await readFile(filePath, 'utf8');
      if (contents.length > MAX_FILE_BYTES) return null;
      return contents;
    } catch {
      // File moved or unreadable since indexing: leave kinds as parsed.
      return null;
    }
  }
}

/**
 * Returns the declaring keyword immediately before `character` on `line`,
 * skipping modifiers. `export abstract class Foo` at the offset of `Foo`
 * yields `class`.
 */
export function declaringKeyword(line: string, character: number): string | null {
  const prefix = line.slice(0, character);
  const tokens = prefix.split(/[^A-Za-z]+/).filter((token) => token.length > 0);

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] as string;
    if (SKIPPABLE_MODIFIERS.has(token)) continue;
    return token;
  }

  return null;
}

/**
 * A refined kind never downgrades structural information the parser already
 * derived: a `method` stays a method even if the line happens to start with
 * `async`.
 */
function applyKind(symbol: ScipSymbol, refined: ScipSymbolKind): ScipSymbol {
  const current = symbol.kind;

  if (current === 'class' || current === 'unknown') {
    return { ...symbol, kind: refined };
  }

  // `const x = () => {}` parses as a variable; the keyword says constant.
  if (current === 'variable' && refined === 'constant') {
    return { ...symbol, kind: 'constant' };
  }

  // Getters and setters arrive as generic methods.
  if (current === 'method' && refined === 'accessor') {
    return { ...symbol, kind: 'accessor' };
  }

  // A top-level `function` already inferred as a function needs no change.
  return symbol;
}

/**
 * A variable declared with a function as its value is a function. Only kinds
 * that describe a variable are changed: a method, property or class keeps the
 * kind it has, whatever the scan says about the position.
 */
const VARIABLE_KINDS: ReadonlySet<ScipSymbolKind> = new Set<ScipSymbolKind>([
  'variable',
  'constant',
  'unknown',
]);

function applyFunctionValue(
  symbol: ScipSymbol,
  scan: FunctionValueScan,
  position: { line: number; character: number },
): ScipSymbol {
  if (!VARIABLE_KINDS.has(symbol.kind)) return symbol;

  const functionValue = scan.declarations.get(positionKey(position.line, position.character));
  if (!functionValue) return symbol;

  return { ...symbol, kind: 'function', functionValue };
}
