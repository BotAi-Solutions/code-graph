import { SUBSTITUTION_MARK } from '../source/ast.js';

/**
 * Table references in a SQL statement.
 *
 * Deliberately not a SQL parser. It recognises the five statement forms that
 * name a table unambiguously and extracts that name; anything more ambitious —
 * subqueries, CTEs, dynamic table names — is left alone, because a wrong table
 * edge is worse than a missing one.
 *
 * A template substitution is replaced upstream by a marker no identifier can
 * contain, so a pattern can never match *through* an interpolation: in
 * `` `SELECT * FROM ${table}` `` nothing is matched, which is the correct
 * answer.
 */

export type SqlAccess = 'read' | 'write';

export interface TableReference {
  table: string;
  access: SqlAccess;
  /** The keyword that produced the match, for the record. */
  statement: string;
}

/** An identifier: bare, "quoted", `backticked`, [bracketed], with an optional schema. */
const IDENTIFIER = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';
const QUALIFIED = `${IDENTIFIER}(?:\\.${IDENTIFIER})?`;

const PATTERNS: ReadonlyArray<{ statement: string; access: SqlAccess; expression: RegExp }> = [
  { statement: 'INSERT', access: 'write', expression: new RegExp(`\\binsert\\s+into\\s+(${QUALIFIED})`, 'gi') },
  { statement: 'UPDATE', access: 'write', expression: new RegExp(`\\bupdate\\s+(?:only\\s+)?(${QUALIFIED})\\s+set\\b`, 'gi') },
  { statement: 'DELETE', access: 'write', expression: new RegExp(`\\bdelete\\s+from\\s+(${QUALIFIED})`, 'gi') },
  {
    statement: 'SELECT',
    access: 'read',
    // `DELETE FROM users` is a write, and its `FROM` must not also register as
    // a read of the same table.
    expression: new RegExp(`(?<!\\bdelete\\s+)\\bfrom\\s+(${QUALIFIED})`, 'gi'),
  },
  { statement: 'JOIN', access: 'read', expression: new RegExp(`\\bjoin\\s+(${QUALIFIED})`, 'gi') },
  { statement: 'CREATE TABLE', access: 'write', expression: new RegExp(`\\bcreate\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${QUALIFIED})`, 'gi') },
  { statement: 'TRUNCATE', access: 'write', expression: new RegExp(`\\btruncate\\s+(?:table\\s+)?(${QUALIFIED})`, 'gi') },
];

/** Statement keywords that must be present for text to be considered SQL. */
const SQL_ANCHOR = /\b(select|insert\s+into|update|delete\s+from|create\s+table|truncate)\b/i;

/** SQL keywords that can follow `FROM` but are not tables. */
const NOT_A_TABLE = new Set([
  'select',
  'dual',
  'unnest',
  'generate_series',
  'values',
  'lateral',
  'json_table',
  'table',
]);

export function looksLikeSql(text: string): boolean {
  return SQL_ANCHOR.test(text);
}

export function findTableReferences(text: string): TableReference[] {
  if (!looksLikeSql(text)) return [];

  const found = new Map<string, TableReference>();

  for (const pattern of PATTERNS) {
    // A fresh regex per call: shared `g` regexes carry `lastIndex` between
    // calls, which would silently skip matches.
    const expression = new RegExp(pattern.expression.source, pattern.expression.flags);

    for (const match of text.matchAll(expression)) {
      const raw = match[1];
      if (raw === undefined) continue;

      const table = normalizeIdentifier(raw);
      if (table === null) continue;

      const key = `${table}:${pattern.access}`;
      if (!found.has(key)) {
        found.set(key, { table, access: pattern.access, statement: pattern.statement });
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.access.localeCompare(b.access),
  );
}

/** Strips quoting and any schema prefix, and rejects non-identifiers. */
function normalizeIdentifier(raw: string): string | null {
  if (raw.includes(SUBSTITUTION_MARK)) return null;

  const last = raw.split('.').pop() ?? raw;
  const unquoted = last.replace(/^["`[]/, '').replace(/["`\]]$/, '').trim();

  if (unquoted.length === 0) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(unquoted)) return null;
  if (NOT_A_TABLE.has(unquoted.toLowerCase())) return null;

  return unquoted;
}
