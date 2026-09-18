import { findTableReferences, type SqlAccess } from '../detectors/sql.js';

/**
 * SQL files, read for the schema they declare and the tables they touch.
 *
 * Deliberately not a SQL parser — the same judgement the in-string detector
 * already makes, for the same reason: a wrong table edge is worse than a
 * missing one. What this recognises is the DDL that names things
 * unambiguously, and what it declines to recognise is everything assembled at
 * runtime.
 *
 *   CREATE TABLE users (...)        the table, and every column in the body
 *   ALTER TABLE users ADD COLUMN    one more column on a table
 *   CREATE INDEX ... ON users (...) an index, and which table it is on
 *   REFERENCES users (id)           a foreign key between two tables
 *   SELECT / INSERT / UPDATE / …    reads and writes, via the shared detector
 *
 * Comments and string literals are blanked before anything is matched, so a
 * table name inside a comment or a seeded value is never mistaken for a
 * declaration. Blanking preserves length and newlines, which is what keeps
 * every reported line number correct.
 */

export interface SqlColumn {
  name: string;
  /** The declared type, normalised to upper case: `TEXT`, `UUID`, `INTEGER`. */
  dataType: string | null;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  /** `table.column` this column references, when it declares a foreign key. */
  references: { table: string; column: string | null } | null;
  line: number;
}

export interface SqlTable {
  name: string;
  /** The schema qualifier as written, when the statement gave one. */
  schema: string | null;
  columns: SqlColumn[];
  /** Table-level primary key columns, from a `PRIMARY KEY (...)` constraint. */
  primaryKey: string[];
  line: number;
  endLine: number;
}

export interface SqlIndex {
  name: string | null;
  table: string;
  columns: string[];
  unique: boolean;
  line: number;
}

export interface SqlForeignKey {
  fromTable: string;
  fromColumn: string | null;
  toTable: string;
  toColumn: string | null;
  line: number;
}

export interface SqlStatementAccess {
  table: string;
  access: SqlAccess;
  /** The keyword that produced the match: `SELECT`, `INSERT`, … */
  statement: string;
  line: number;
}

export interface SqlSchema {
  relativePath: string;
  tables: SqlTable[];
  indexes: SqlIndex[];
  foreignKeys: SqlForeignKey[];
  /** Tables read or written by DML in this file, outside the DDL above. */
  accesses: SqlStatementAccess[];
}

const IDENTIFIER = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';
const QUALIFIED = `${IDENTIFIER}(?:\\.${IDENTIFIER})?`;

const CREATE_TABLE = new RegExp(
  `\\bcreate\\s+(?:(?:global|local)\\s+)?(?:(?:temp|temporary|unlogged)\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(${QUALIFIED})\\s*\\(`,
  'gi',
);
const ALTER_TABLE_ADD = new RegExp(
  `\\balter\\s+table\\s+(?:only\\s+)?(${QUALIFIED})\\s+add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?(${IDENTIFIER})\\s+([A-Za-z][\\w ]*(?:\\([^)]*\\))?)`,
  'gi',
);
const CREATE_INDEX = new RegExp(
  `\\bcreate\\s+(unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?(${QUALIFIED})?\\s*on\\s+(${QUALIFIED})\\s*\\(([^)]*)\\)`,
  'gi',
);

/** Words that can start a line inside a `CREATE TABLE` body but are not columns. */
const TABLE_CONSTRAINTS = new Set([
  'primary',
  'foreign',
  'unique',
  'check',
  'constraint',
  'exclude',
  'like',
  'index',
  'key',
]);

export function parseSqlSchema(relativePath: string, text: string): SqlSchema {
  const clean = blankNoise(text);
  const lineStarts = indexLineStarts(clean);
  const lineAt = (offset: number): number => lineNumber(lineStarts, offset);

  const tables: SqlTable[] = [];
  const indexes: SqlIndex[] = [];
  const foreignKeys: SqlForeignKey[] = [];

  // Offsets covered by a `CREATE TABLE` body, so the DML sweep at the end does
  // not report a column's `REFERENCES users` as a read of `users`.
  const ddlRanges: Array<[number, number]> = [];

  for (const match of clean.matchAll(CREATE_TABLE)) {
    const raw = match[1];
    if (raw === undefined || match.index === undefined) continue;

    const open = match.index + match[0].length - 1;
    const close = matchParen(clean, open);
    if (close === -1) continue;

    ddlRanges.push([match.index, close]);

    const { schema, name } = splitQualified(raw);
    if (name === null) continue;

    const body = clean.slice(open + 1, close);
    const parsed = parseColumns(body, open + 1, lineAt);

    tables.push({
      name,
      schema,
      columns: parsed.columns,
      primaryKey: parsed.primaryKey,
      line: lineAt(match.index),
      endLine: lineAt(close),
    });

    for (const key of parsed.foreignKeys) {
      foreignKeys.push({ ...key, fromTable: name });
    }
  }

  for (const match of clean.matchAll(ALTER_TABLE_ADD)) {
    const rawTable = match[1];
    const rawColumn = match[2];
    if (rawTable === undefined || rawColumn === undefined || match.index === undefined) continue;

    const { name } = splitQualified(rawTable);
    const column = unquote(rawColumn);
    if (name === null || column === null) continue;

    ddlRanges.push([match.index, match.index + match[0].length]);

    const line = lineAt(match.index);
    const existing = tables.find((table) => table.name === name);

    const declared: SqlColumn = {
      name: column,
      dataType: normalizeType(match[3] ?? null),
      notNull: /\bnot\s+null\b/i.test(match[0]),
      primaryKey: false,
      unique: /\bunique\b/i.test(match[0]),
      references: null,
      line,
    };

    if (existing) {
      if (!existing.columns.some((entry) => entry.name === column)) existing.columns.push(declared);
      continue;
    }

    // An `ALTER TABLE` for a table created in another migration. The table is
    // still a fact; it simply has one known column.
    tables.push({
      name,
      schema: splitQualified(rawTable).schema,
      columns: [declared],
      primaryKey: [],
      line,
      endLine: line,
    });
  }

  for (const match of clean.matchAll(CREATE_INDEX)) {
    const rawTable = match[3];
    if (rawTable === undefined || match.index === undefined) continue;

    const { name: table } = splitQualified(rawTable);
    if (table === null) continue;

    ddlRanges.push([match.index, match.index + match[0].length]);

    indexes.push({
      name: match[2] === undefined ? null : unquote(match[2]),
      table,
      columns: splitList(match[4] ?? '')
        .map((column) => unquote(column.split(/\s+/)[0] ?? ''))
        .filter((column): column is string => column !== null),
      unique: match[1] !== undefined,
      line: lineAt(match.index),
    });
  }

  return {
    relativePath,
    tables,
    indexes,
    foreignKeys,
    accesses: collectAccesses(clean, ddlRanges, lineStarts),
  };
}

/**
 * Reads and writes outside the DDL.
 *
 * Split into statements on `;` so a line number points at the statement that
 * produced the finding rather than at the top of the file, and so a `FROM` in
 * one statement cannot pair with an `INSERT` in the next.
 */
function collectAccesses(
  clean: string,
  ddlRanges: ReadonlyArray<[number, number]>,
  lineStarts: readonly number[],
): SqlStatementAccess[] {
  const accesses: SqlStatementAccess[] = [];
  const seen = new Set<string>();

  let cursor = 0;
  for (const chunk of clean.split(';')) {
    const start = cursor;
    cursor += chunk.length + 1;

    const inDdl = ddlRanges.some(([from, to]) => start < to && from < start + chunk.length);
    if (inDdl) continue;
    if (chunk.trim().length === 0) continue;

    const line = lineNumber(lineStarts, start + leadingSpace(chunk));

    for (const reference of findTableReferences(chunk)) {
      const key = `${reference.table}:${reference.access}:${String(line)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      accesses.push({
        table: reference.table,
        access: reference.access,
        statement: reference.statement,
        line,
      });
    }
  }

  return accesses;
}

function leadingSpace(chunk: string): number {
  const match = /^\s*/.exec(chunk);
  return match?.[0].length ?? 0;
}

interface ParsedBody {
  columns: SqlColumn[];
  primaryKey: string[];
  foreignKeys: Array<Omit<SqlForeignKey, 'fromTable'>>;
}

function parseColumns(
  body: string,
  bodyOffset: number,
  lineAt: (offset: number) => number,
): ParsedBody {
  const columns: SqlColumn[] = [];
  const primaryKey: string[] = [];
  const foreignKeys: Array<Omit<SqlForeignKey, 'fromTable'>> = [];

  let offset = 0;

  for (const part of splitTopLevel(body)) {
    const definition = part.trim();
    const absolute = bodyOffset + offset + (part.length - part.trimStart().length);
    offset += part.length + 1;

    if (definition.length === 0) continue;

    const first = (/^\S+/.exec(definition)?.[0] ?? '').toLowerCase().replace(/^[("`[]/, '');

    if (TABLE_CONSTRAINTS.has(first)) {
      const pk = /\bprimary\s+key\s*\(([^)]*)\)/i.exec(definition);
      if (pk?.[1] !== undefined) {
        for (const column of splitList(pk[1])) {
          const name = unquote(column);
          if (name !== null) primaryKey.push(name);
        }
      }

      const fk = /\bforeign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(
        definition,
      );
      if (fk?.[2] !== undefined) {
        const target = splitQualified(fk[2]).name;
        if (target !== null) {
          foreignKeys.push({
            fromColumn: unquote(splitList(fk[1] ?? '')[0] ?? ''),
            toTable: target,
            toColumn: unquote(splitList(fk[3] ?? '')[0] ?? ''),
            line: lineAt(absolute),
          });
        }
      }
      continue;
    }

    const nameMatch = new RegExp(`^(${IDENTIFIER})\\s+(.*)$`, 's').exec(definition);
    if (!nameMatch?.[1]) continue;

    const name = unquote(nameMatch[1]);
    if (name === null) continue;

    const rest = nameMatch[2] ?? '';
    const reference = /\breferences\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(rest);
    const referencedTable = reference?.[1] === undefined ? null : splitQualified(reference[1]).name;
    const line = lineAt(absolute);

    const column: SqlColumn = {
      name,
      dataType: normalizeType(rest),
      notNull: /\bnot\s+null\b/i.test(rest),
      primaryKey: /\bprimary\s+key\b/i.test(rest),
      unique: /\bunique\b/i.test(rest),
      references:
        referencedTable === null
          ? null
          : { table: referencedTable, column: unquote(splitList(reference?.[2] ?? '')[0] ?? '') },
      line,
    };

    columns.push(column);
    if (column.primaryKey) primaryKey.push(name);
    if (column.references) {
      foreignKeys.push({
        fromColumn: name,
        toTable: column.references.table,
        toColumn: column.references.column,
        line,
      });
    }
  }

  return { columns, primaryKey, foreignKeys };
}

// --- text utilities --------------------------------------------------------

/**
 * Replaces comments and string literals with spaces of the same length.
 *
 * Same length and same newlines, so every offset computed afterwards still
 * points at the character it did in the original file. Blanking rather than
 * deleting is the whole reason the line numbers can be trusted.
 */
export function blankNoise(text: string): string {
  const out = text.split('');
  let index = 0;

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  while (index < text.length) {
    const char = text[index];

    if (char === '-' && text[index + 1] === '-') {
      const end = text.indexOf('\n', index);
      blank(index, end === -1 ? text.length : end);
      index = end === -1 ? text.length : end;
      continue;
    }

    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      // A double-quoted identifier is not a literal in standard SQL, but a
      // quoted *table name* is matched by the identifier pattern either way, so
      // blanking it would lose the declaration. Only single quotes and
      // backticks hold values.
      if (char === '"') {
        const end = text.indexOf('"', index + 1);
        index = end === -1 ? text.length : end + 1;
        continue;
      }

      let end = index + 1;
      while (end < text.length) {
        if (text[end] === char) {
          if (text[end + 1] === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      blank(index, Math.min(end + 1, text.length));
      index = Math.min(end + 1, text.length);
      continue;
    }

    index += 1;
  }

  return out.join('');
}

function indexLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineNumber(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;

    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function splitQualified(raw: string): { schema: string | null; name: string | null } {
  const parts = raw.split('.');
  if (parts.length === 1) return { schema: null, name: unquote(parts[0] ?? '') };
  return { schema: unquote(parts[0] ?? ''), name: unquote(parts[1] ?? '') };
}

function unquote(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["`[]/, '').replace(/["`\]]$/, '').trim();
  if (trimmed.length === 0) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Keywords that end a type and begin a constraint.
 *
 * Needed because a column definition is `<name> <type> <constraints…>` with
 * nothing between the two but a space, and the type itself may be several words
 * (`DOUBLE PRECISION`, `TIMESTAMP WITH TIME ZONE`). Cutting at the first
 * constraint keyword is what tells `TEXT NOT NULL UNIQUE` from a type called
 * "text not null unique".
 */
const CONSTRAINT_KEYWORD =
  /\b(not\s+null|null|primary\s+key|unique|default|references|check|constraint|generated|collate|identity|auto_increment)\b/i;

/**
 * The declared type, upper-cased, with its constraints removed.
 *
 * Returns null when there is nothing left, which is the right answer for a
 * definition that is all constraint — a table-level `PRIMARY KEY (...)` reaches
 * here only if it slipped past the constraint check, and reporting no type is
 * better than reporting "PRIMARY".
 */
function normalizeType(raw: string | null): string | null {
  if (raw === null) return null;

  const cut = CONSTRAINT_KEYWORD.exec(raw);
  const head = cut ? raw.slice(0, cut.index) : raw;

  const cleaned = head.trim().replace(/,$/, '').replace(/\s+/g, ' ');
  if (cleaned.length === 0) return null;
  if (!/^[A-Za-z]/.test(cleaned)) return null;

  return cleaned.toUpperCase();
}
