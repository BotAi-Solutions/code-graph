import type {
  StructuredDocument,
  StructuredEntry,
  StructuredNode,
  StructuredPosition,
} from './structured.js';

/**
 * JSON, with positions, and tolerant of the two things real repositories put in
 * their JSON.
 *
 * `JSON.parse` would be shorter and is not enough for two reasons. It throws
 * away every position, and a configuration property whose evidence cannot name
 * a line is a property nobody can check. And it rejects `tsconfig.json`, which
 * the TypeScript ecosystem has written with comments and trailing commas for a
 * decade — refusing to read the single most common configuration file in a
 * TypeScript repository would be a strange way to start.
 *
 * So: a recursive-descent parser over a hand-written scanner. It accepts JSON
 * plus `//` and block comments plus trailing commas, and rejects everything
 * else with a message naming the line. It never throws; a malformed file comes
 * back with `root: null` and an `error`, because one unparsable config must not
 * end an analysis.
 */

class JsonParseError extends Error {}

interface Cursor {
  readonly text: string;
  offset: number;
  line: number;
  column: number;
}

/** Depth beyond which a document is assumed hostile rather than nested. */
const MAX_DEPTH = 64;

export function parseJsonDocument(relativePath: string, text: string): StructuredDocument {
  const cursor: Cursor = { text, offset: 0, line: 1, column: 0 };

  try {
    skipTrivia(cursor);
    if (cursor.offset >= text.length) {
      return { relativePath, format: 'json', root: null, error: null };
    }

    const root = parseValue(cursor, 0);
    skipTrivia(cursor);

    if (cursor.offset < text.length) {
      throw new JsonParseError(
        `unexpected ${describe(text[cursor.offset])} after the top-level value at line ${String(cursor.line)}`,
      );
    }

    return { relativePath, format: 'json', root, error: null };
  } catch (error) {
    return {
      relativePath,
      format: 'json',
      root: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** True when the text parses. Cheaper to read than `parse(...).error === null`. */
export function isParsableJson(text: string): boolean {
  return parseJsonDocument('', text).error === null;
}

// --- scanner ---------------------------------------------------------------

function position(cursor: Cursor): StructuredPosition {
  return { line: cursor.line, column: cursor.column };
}

function advance(cursor: Cursor, count = 1): void {
  for (let i = 0; i < count; i += 1) {
    if (cursor.text[cursor.offset] === '\n') {
      cursor.line += 1;
      cursor.column = 0;
    } else {
      cursor.column += 1;
    }
    cursor.offset += 1;
  }
}

/** Whitespace and comments. JSON proper has no comments; JSONC does. */
function skipTrivia(cursor: Cursor): void {
  while (cursor.offset < cursor.text.length) {
    const char = cursor.text[cursor.offset];

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      advance(cursor);
      continue;
    }

    if (char === '/' && cursor.text[cursor.offset + 1] === '/') {
      while (cursor.offset < cursor.text.length && cursor.text[cursor.offset] !== '\n') {
        advance(cursor);
      }
      continue;
    }

    if (char === '/' && cursor.text[cursor.offset + 1] === '*') {
      advance(cursor, 2);
      while (
        cursor.offset < cursor.text.length &&
        !(cursor.text[cursor.offset] === '*' && cursor.text[cursor.offset + 1] === '/')
      ) {
        advance(cursor);
      }
      if (cursor.offset >= cursor.text.length) {
        throw new JsonParseError('unterminated block comment');
      }
      advance(cursor, 2);
      continue;
    }

    return;
  }
}

function describe(char: string | undefined): string {
  return char === undefined ? 'end of file' : `'${char}'`;
}

function expect(cursor: Cursor, char: string): void {
  if (cursor.text[cursor.offset] !== char) {
    throw new JsonParseError(
      `expected '${char}' but found ${describe(cursor.text[cursor.offset])} at line ${String(cursor.line)}`,
    );
  }
  advance(cursor);
}

// --- parser ----------------------------------------------------------------

function parseValue(cursor: Cursor, depth: number): StructuredNode {
  if (depth > MAX_DEPTH) throw new JsonParseError('nesting is deeper than the parser will follow');

  skipTrivia(cursor);
  const char = cursor.text[cursor.offset];

  if (char === '{') return parseObject(cursor, depth);
  if (char === '[') return parseArray(cursor, depth);
  if (char === '"') {
    const start = position(cursor);
    return { kind: 'string', ...start, value: parseString(cursor) };
  }
  if (char === 't' || char === 'f') return parseBoolean(cursor);
  if (char === 'n') return parseNull(cursor);
  if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) return parseNumber(cursor);

  throw new JsonParseError(
    `unexpected ${describe(char)} where a value was expected at line ${String(cursor.line)}`,
  );
}

function parseObject(cursor: Cursor, depth: number): StructuredNode {
  const start = position(cursor);
  expect(cursor, '{');

  const entries: StructuredEntry[] = [];
  // Last writer wins, as `JSON.parse` does, while document order is preserved
  // for every key that is written only once.
  const seen = new Map<string, number>();

  for (;;) {
    skipTrivia(cursor);
    if (cursor.text[cursor.offset] === '}') {
      advance(cursor);
      break;
    }
    if (cursor.offset >= cursor.text.length) throw new JsonParseError('unterminated object');

    const keyPosition = position(cursor);
    const key = parseString(cursor);

    skipTrivia(cursor);
    expect(cursor, ':');

    const value = parseValue(cursor, depth + 1);

    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, entries.length);
      entries.push({ key, keyPosition, value });
    } else {
      entries[existing] = { key, keyPosition, value };
    }

    skipTrivia(cursor);
    if (cursor.text[cursor.offset] === ',') {
      advance(cursor);
      continue;
    }
    if (cursor.text[cursor.offset] === '}') {
      advance(cursor);
      break;
    }
    throw new JsonParseError(
      `expected ',' or '}' but found ${describe(cursor.text[cursor.offset])} at line ${String(cursor.line)}`,
    );
  }

  return { kind: 'object', ...start, entries };
}

function parseArray(cursor: Cursor, depth: number): StructuredNode {
  const start = position(cursor);
  expect(cursor, '[');

  const items: StructuredNode[] = [];

  for (;;) {
    skipTrivia(cursor);
    if (cursor.text[cursor.offset] === ']') {
      advance(cursor);
      break;
    }
    if (cursor.offset >= cursor.text.length) throw new JsonParseError('unterminated array');

    items.push(parseValue(cursor, depth + 1));

    skipTrivia(cursor);
    if (cursor.text[cursor.offset] === ',') {
      advance(cursor);
      continue;
    }
    if (cursor.text[cursor.offset] === ']') {
      advance(cursor);
      break;
    }
    throw new JsonParseError(
      `expected ',' or ']' but found ${describe(cursor.text[cursor.offset])} at line ${String(cursor.line)}`,
    );
  }

  return { kind: 'array', ...start, items };
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function parseString(cursor: Cursor): string {
  expect(cursor, '"');

  let value = '';

  for (;;) {
    const char = cursor.text[cursor.offset];
    if (char === undefined) throw new JsonParseError('unterminated string');

    if (char === '"') {
      advance(cursor);
      return value;
    }

    if (char === '\\') {
      advance(cursor);
      const escape = cursor.text[cursor.offset];
      if (escape === undefined) throw new JsonParseError('unterminated escape sequence');

      if (escape === 'u') {
        const hex = cursor.text.slice(cursor.offset + 1, cursor.offset + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new JsonParseError(`invalid unicode escape at line ${String(cursor.line)}`);
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        advance(cursor, 5);
        continue;
      }

      const mapped = ESCAPES[escape];
      if (mapped === undefined) {
        throw new JsonParseError(`invalid escape '\\${escape}' at line ${String(cursor.line)}`);
      }
      value += mapped;
      advance(cursor);
      continue;
    }

    value += char;
    advance(cursor);
  }
}

function parseNumber(cursor: Cursor): StructuredNode {
  const start = position(cursor);
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
    cursor.text.slice(cursor.offset),
  );
  if (!match) throw new JsonParseError(`invalid number at line ${String(cursor.line)}`);

  advance(cursor, match[0].length);
  return { kind: 'number', ...start, value: Number(match[0]) };
}

function parseBoolean(cursor: Cursor): StructuredNode {
  const start = position(cursor);

  if (cursor.text.startsWith('true', cursor.offset)) {
    advance(cursor, 4);
    return { kind: 'boolean', ...start, value: true };
  }
  if (cursor.text.startsWith('false', cursor.offset)) {
    advance(cursor, 5);
    return { kind: 'boolean', ...start, value: false };
  }
  throw new JsonParseError(`invalid literal at line ${String(cursor.line)}`);
}

function parseNull(cursor: Cursor): StructuredNode {
  const start = position(cursor);
  if (!cursor.text.startsWith('null', cursor.offset)) {
    throw new JsonParseError(`invalid literal at line ${String(cursor.line)}`);
  }
  advance(cursor, 4);
  return { kind: 'null', ...start, value: null };
}
