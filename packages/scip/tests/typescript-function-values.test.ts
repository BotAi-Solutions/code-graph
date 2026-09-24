import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  TypeScriptSymbolRefiner,
  positionKey,
  readScipIndexFile,
  scanFunctionValues,
  type ScipDocument,
  type ScipIndex,
  type ScipSymbol,
} from '@ckg/scip';

/**
 * Function-valued variables, as the TypeScript refiner recovers them.
 *
 * The scanner is exercised on inline source, where every position is known,
 * and the refiner on the `function-values-sample` fixture, which is what the
 * graph builder actually receives.
 */

/** The zero-based position of the first `name` in `text` at or after `from`. */
function positionOf(text: string, name: string, from = 0): string {
  const offset = text.indexOf(name, from);
  if (offset < 0) throw new Error(`${name} not in source`);
  const before = text.slice(0, offset).split('\n');
  return positionKey(before.length - 1, (before.at(-1) ?? '').length);
}

describe('scanFunctionValues', () => {
  it('recognises arrow functions and function expressions bound by const', () => {
    const text = [
      'const plain = () => {};',
      'const withArgument = (x: number) => x;',
      'const awaited = async () => {};',
      'const multiline = (a: number, b: number) => {',
      '  return a + b;',
      '};',
      'const generic = <T>(value: T) => value;',
      'const expression = function () {};',
      'const asyncExpression = async function () {};',
      'const parenthesized = (() => 1);',
    ].join('\n');

    const { declarations } = scanFunctionValues('a.ts', text);

    expect(declarations.get(positionOf(text, 'plain'))).toBe('arrow-function');
    expect(declarations.get(positionOf(text, 'withArgument'))).toBe('arrow-function');
    expect(declarations.get(positionOf(text, 'awaited'))).toBe('arrow-function');
    expect(declarations.get(positionOf(text, 'multiline'))).toBe('arrow-function');
    expect(declarations.get(positionOf(text, 'generic'))).toBe('arrow-function');
    expect(declarations.get(positionOf(text, 'expression'))).toBe('function-expression');
    expect(declarations.get(positionOf(text, 'asyncExpression'))).toBe('function-expression');
    expect(declarations.get(positionOf(text, 'parenthesized'))).toBe('arrow-function');
    expect(declarations.size).toBe(8);
  });

  it('does not treat values as functions, however they are later used', () => {
    const text = [
      'const object = {};',
      'const array = [];',
      'const number = 123;',
      'const string = "foo";',
      'const made = makeHandler();',
      'const cast = handler as Handler;',
      'const members = { run: () => 1 };',
      'let reassignable = () => 1;',
      'var legacy = function () {};',
      'const { destructured } = { destructured: () => 1 };',
      'object(); made(); cast();',
    ].join('\n');

    expect(scanFunctionValues('a.ts', text).declarations.size).toBe(0);
  });

  it('marks the callee of each call, and nothing that is only a value', () => {
    const text = [
      'helper();',
      'async function f() { await helper(); }',
      'function g() { return helper(); }',
      'ns.member();',
      'optional?.();',
      'typed<string>();',
      'register(callback);',
      'const alias = aliased;',
      'bound.bind(null);',
      'new Constructed();',
      'tag`template`;',
    ].join('\n');

    const { callees } = scanFunctionValues('a.ts', text);

    // Three calls of `helper`, one per line.
    for (let line = 0; line < 3; line += 1) {
      expect([...callees].some((key) => key.startsWith(`${String(line)}:`))).toBe(true);
    }
    expect(callees.has(positionOf(text, 'member'))).toBe(true);
    expect(callees.has(positionOf(text, 'ns'))).toBe(false);
    expect(callees.has(positionOf(text, 'optional'))).toBe(true);
    expect(callees.has(positionOf(text, 'typed'))).toBe(true);
    expect(callees.has(positionOf(text, 'register'))).toBe(true);

    expect(callees.has(positionOf(text, 'callback'))).toBe(false);
    expect(callees.has(positionOf(text, 'aliased'))).toBe(false);
    expect(callees.has(positionOf(text, 'bound'))).toBe(false);
    expect(callees.has(positionOf(text, 'bind'))).toBe(true);
    expect(callees.has(positionOf(text, 'Constructed'))).toBe(false);
    expect(callees.has(positionOf(text, 'tag'))).toBe(false);
  });

  it('parses JavaScript and JSX as well as TypeScript', () => {
    const text = 'export const view = () => <div />;\nview();';

    const scan = scanFunctionValues('component.jsx', text);

    expect(scan.declarations.get(positionOf(text, 'view'))).toBe('arrow-function');
    expect(scan.callees.has(positionKey(1, 0))).toBe(true);
  });
});

describe('TypeScriptSymbolRefiner on function values', () => {
  const FIXTURE = fileURLToPath(
    new URL('./fixtures/function-values-sample.scip', import.meta.url),
  );
  const REPOSITORY = path.resolve(
    fileURLToPath(new URL('../../../test-repositories/function-values-sample', import.meta.url)),
  );

  let index: ScipIndex;

  beforeAll(async () => {
    index = await new TypeScriptSymbolRefiner().refine(await readScipIndexFile(FIXTURE), {
      repositoryPath: REPOSITORY,
    });
  });

  const document = (file: string): ScipDocument => {
    const found = index.documents.find((candidate) => candidate.relativePath === `src/${file}`);
    if (!found) throw new Error(`no document for ${file}`);
    return found;
  };

  const symbol = (file: string, name: string): ScipSymbol => {
    const found = document(file).symbols.find(
      (candidate) => candidate.name === name && !candidate.identity.isLocal,
    );
    if (!found) throw new Error(`no symbol ${name} in ${file}`);
    return found;
  };

  it('turns function-valued consts into functions and records how they were written', () => {
    expect(symbol('helpers.ts', 'formatName')).toMatchObject({
      kind: 'function',
      functionValue: 'arrow-function',
    });
    expect(symbol('helpers.ts', 'legacyFormat')).toMatchObject({
      kind: 'function',
      functionValue: 'function-expression',
    });
    expect(symbol('access.ts', 'requireUploadAccess')).toMatchObject({ kind: 'function' });
  });

  it('leaves values, let bindings and declared functions as they were', () => {
    for (const name of ['settings', 'names', 'limit', 'label', 'formatters', 'mutable']) {
      expect(symbol('helpers.ts', name).kind).not.toBe('function');
      expect(symbol('helpers.ts', name).functionValue).toBeUndefined();
    }
    expect(symbol('callers.ts', 'callsArrow')).toMatchObject({ kind: 'function' });
    expect(symbol('callers.ts', 'callsArrow').functionValue).toBeUndefined();
  });

  it('marks call-site occurrences, and never a definition', () => {
    const callers = document('callers.ts');
    const formatName = symbol('helpers.ts', 'formatName').id;
    const occurrences = callers.occurrences.filter((occurrence) => occurrence.symbolId === formatName);

    // Imported, aliased, called twice and returned in an array.
    expect(occurrences.filter((occurrence) => occurrence.isCall)).toHaveLength(2);
    expect(occurrences.filter((occurrence) => !occurrence.isCall).length).toBeGreaterThanOrEqual(3);
    expect(index.documents.flatMap((doc) => doc.occurrences).some((o) => o.isDefinition && o.isCall)).toBe(
      false,
    );
  });
});
