import type { AnalyzerNodeDraft } from '@ckg/graph';

/**
 * The database, table and column nodes, in one place.
 *
 * Three analyzers now have something to say about the same table: the database
 * analyzer sees a `SELECT` in a string literal, the SQL analyzer sees the
 * `CREATE TABLE` that declared it, and a Prisma schema declares it a third way.
 * They must produce the *same node*, or a repository ends up with `users`
 * twice and the graph stops being able to answer "who touches this table".
 *
 * Identity is a content hash of (type, filePath, symbolKey), so sameness is
 * achieved by building the same draft — which is why this is a shared function
 * rather than a lookup, exactly as `service-node.ts` is. A table has no
 * `filePath` on purpose: the same table touched from three files and declared
 * in a fourth is one table.
 */

/** `postgresql.users`, or just `users` when no provider was established. */
export function tableQualifiedName(table: string, provider: string | null): string {
  return provider ? `${provider}.${table}` : table;
}

export function databaseDraft(provider: string, detectedFrom: string): AnalyzerNodeDraft {
  return {
    type: 'database',
    name: provider,
    symbolKey: `database:${provider}`,
    qualifiedName: provider,
    metadata: { provider, detectedFrom },
  };
}

export function tableDraft(
  table: string,
  provider: string | null,
  extra: Record<string, unknown> = {},
): AnalyzerNodeDraft {
  const qualifiedName = tableQualifiedName(table, provider);

  const metadata: Record<string, unknown> = { table };
  if (provider) metadata.provider = provider;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) metadata[key] = value;
  }

  return {
    type: 'table',
    name: table,
    symbolKey: `table:${qualifiedName}`,
    qualifiedName,
    metadata,
  };
}

/**
 * A column of a table.
 *
 * Keyed on the table's qualified name so two migrations declaring the same
 * column produce one node, and so a column called `id` on `users` is never the
 * same node as a column called `id` on `orders` — which a name-only key would
 * make it.
 */
export function columnDraft(
  table: string,
  provider: string | null,
  column: string,
  extra: Record<string, unknown> = {},
): AnalyzerNodeDraft {
  const qualified = `${tableQualifiedName(table, provider)}.${column}`;

  const metadata: Record<string, unknown> = { table, column };
  if (provider) metadata.provider = provider;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) metadata[key] = value;
  }

  return {
    type: 'column',
    name: column,
    symbolKey: `column:${qualified}`,
    qualifiedName: qualified,
    metadata,
  };
}
