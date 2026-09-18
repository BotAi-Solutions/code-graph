import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEdgeDraft,
  AnalyzerNodeDraft,
  CodeAnalyzer,
  NodeReference,
} from '@ckg/graph';
import { draftRef } from '@ckg/graph';
import { classifyFile } from '@ckg/language-detection';
import { evidence, type EdgeEvidence } from '@ckg/shared';
import { detectDatabaseProvider } from '../detectors/provider.js';
import type { SqlSchema, SqlTable } from '../parsers/sql-schema.js';
import { ResourceTree } from '../source/resource-file.js';
import { sqlSchemaFor } from '../source/shared.js';
import { columnDraft, databaseDraft, tableDraft } from '../source/table-node.js';

/**
 * The data model as the repository declares it, rather than as its code uses it.
 *
 * The database analyzer reads SQL out of string literals: it finds the tables
 * that are *touched*, and only those. A repository with a `migrations/`
 * directory has already written down its whole schema — every table, every
 * column, every foreign key — and reading it is the difference between a graph
 * that knows `users` exists because something selected from it and one that
 * knows `users` has nine columns, three of which point at other tables.
 *
 * The two must agree, and they do by construction: both build their table nodes
 * with `tableDraft`, whose identity is the provider-qualified name, so the
 * `users` a migration declares and the `users` a repository class writes to are
 * one node. That shared identity is the whole reason the provider is detected
 * once, in `detectors/provider.ts`, rather than twice.
 */

const ANALYZER = 'sql-analyzer';

/**
 * Grouping a table under its provider.
 *
 * `graph`, not `sql`: which provider a table belongs to is not written in the
 * migration — it comes from the driver the repository depends on — so there is
 * no line in the SQL file to point at and none is claimed.
 */
const GROUPING: EdgeEvidence = evidence({
  source: ANALYZER,
  basis: 'declaredInSpec',
  method: 'graph',
});

const SQL_SUFFIXES = ['.sql', '.ddl', '.psql'] as const;

/** Columns promoted from one table. Beyond this it is a data warehouse. */
const MAX_COLUMNS_PER_TABLE = 200;

export class SqlAnalyzer implements CodeAnalyzer {
  readonly name = ANALYZER;
  /**
   * Source, not classification: the tables it declares must exist before the
   * classification stage reasons about what reads them, and its nodes merge
   * with the database analyzer's, which runs in this stage too.
   */
  readonly stage: AnalysisStage = 'source';

  supports(context: AnalysisContext): boolean {
    return context.sources.matching(...SQL_SUFFIXES).length > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const repository = context.symbols.repository();
    const tree = new ResourceTree(repository?.id ?? null, ANALYZER);

    const provider = detectDatabaseProvider(context);
    const providerName = provider?.name ?? null;

    const nodes = new Map<string, AnalyzerNodeDraft>();
    const edges: AnalyzerEdgeDraft[] = [];

    const database = provider ? databaseDraft(provider.name, provider.evidence) : null;
    if (database) nodes.set(database.symbolKey, database);

    /** The table node, created on first mention and shared thereafter. */
    const table = (name: string, extra: Record<string, unknown> = {}): NodeReference => {
      const draft = tableDraft(name, providerName, extra);
      const existing = nodes.get(draft.symbolKey);

      if (!existing) {
        nodes.set(draft.symbolKey, draft);
        if (database) {
          edges.push({
            from: draftRef(database),
            to: draftRef(draft),
            relationship: 'CONTAINS',
            evidence: GROUPING,
          });
        }
      }
      return draftRef(existing ?? draft);
    };

    // Declarations, not distinct tables: two migrations touching `users`
    // declare it twice and both are worth counting.
    let tableCount = 0;
    let columnCount = 0;
    let foreignKeyCount = 0;
    let readCount = 0;
    let writeCount = 0;

    for (const file of context.sources.matching(...SQL_SUFFIXES)) {
      const schema = sqlSchemaFor(context.sources, file.relativePath);
      if (!schema) continue;

      const classification = classifyFile(file.relativePath);
      const fileRef = tree.file({
        classification,
        // A `.sql` file is a file. Its *contents* are tables and columns, and
        // those are first-class nodes already; a second node type whose only
        // job is to be the file they were written in would earn nothing.
        type: 'file',
        metadata: {
          tableCount: schema.tables.length,
          indexCount: schema.indexes.length,
        },
      });

      tableCount += schema.tables.length;
      columnCount += this.declare(schema, fileRef, table, providerName, nodes, edges);
      foreignKeyCount += this.foreignKeys(schema, table, edges);

      for (const access of schema.accesses) {
        if (access.access === 'write') writeCount += 1;
        else readCount += 1;

        edges.push({
          from: fileRef,
          to: table(access.table),
          relationship: access.access === 'write' ? 'WRITES_TO' : 'READS_FROM',
          evidence: evidence({
            source: ANALYZER,
            basis: 'sqlLiteral',
            method: 'sql',
            file: schema.relativePath,
            line: access.line,
            matched: access.table,
          }),
          metadata: { statement: access.statement },
        });
      }
    }

    return {
      nodes: [...tree.nodes(), ...nodes.values()],
      edges: [...tree.edges(), ...edges],
      stats: {
        sqlFileCount: context.sources.matching(...SQL_SUFFIXES).length,
        tableDeclarationCount: tableCount,
        columnCount,
        foreignKeyCount,
        readCount,
        writeCount,
      },
    };
  }

  /** Tables and columns a file declares, and the `DEFINES` edges to them. */
  private declare(
    schema: SqlSchema,
    fileRef: NodeReference,
    table: (name: string, extra?: Record<string, unknown>) => NodeReference,
    provider: string | null,
    nodes: Map<string, AnalyzerNodeDraft>,
    edges: AnalyzerEdgeDraft[],
  ): number {
    let columns = 0;

    for (const declared of schema.tables) {
      const indexes = schema.indexes.filter((index) => index.table === declared.name);

      const tableRef = table(declared.name, {
        declaredIn: schema.relativePath,
        ...(declared.schema !== null ? { sqlSchema: declared.schema } : {}),
        ...(declared.primaryKey.length > 0 ? { primaryKey: declared.primaryKey } : {}),
        ...(indexes.length > 0
          ? { indexes: indexes.map((index) => index.name ?? index.columns.join(',')) }
          : {}),
      });

      edges.push({
        from: fileRef,
        to: tableRef,
        relationship: 'DEFINES',
        evidence: evidence({
          source: ANALYZER,
          basis: 'sqlLiteral',
          method: 'sql',
          file: schema.relativePath,
          line: declared.line,
          matched: declared.name,
        }),
        metadata: { columnCount: declared.columns.length },
      });

      columns += this.columns(schema, declared, tableRef, provider, nodes, edges);
    }

    return columns;
  }

  private columns(
    schema: SqlSchema,
    declared: SqlTable,
    tableRef: NodeReference,
    provider: string | null,
    nodes: Map<string, AnalyzerNodeDraft>,
    edges: AnalyzerEdgeDraft[],
  ): number {
    let created = 0;

    for (const column of declared.columns.slice(0, MAX_COLUMNS_PER_TABLE)) {
      const draft = columnDraft(declared.name, provider, column.name, {
        ...(column.dataType !== null ? { dataType: column.dataType } : {}),
        ...(column.notNull ? { notNull: true } : {}),
        ...(column.primaryKey || declared.primaryKey.includes(column.name)
          ? { primaryKey: true }
          : {}),
        ...(column.unique ? { unique: true } : {}),
        declaredIn: schema.relativePath,
      });

      if (nodes.has(draft.symbolKey)) continue;
      nodes.set(draft.symbolKey, draft);
      created += 1;

      edges.push({
        from: tableRef,
        to: draftRef(draft),
        relationship: 'CONTAINS',
        evidence: evidence({
          source: ANALYZER,
          basis: 'sqlLiteral',
          method: 'sql',
          file: schema.relativePath,
          line: column.line,
          matched: `${declared.name}.${column.name}`,
        }),
      });
    }

    return created;
  }

  /** `REFERENCES other(id)` — one table pointing at another. */
  private foreignKeys(
    schema: SqlSchema,
    table: (name: string) => NodeReference,
    edges: AnalyzerEdgeDraft[],
  ): number {
    let count = 0;

    for (const key of schema.foreignKeys) {
      if (key.toTable === key.fromTable) continue;
      count += 1;

      edges.push({
        from: table(key.fromTable),
        to: table(key.toTable),
        relationship: 'REFERENCES',
        evidence: evidence({
          source: ANALYZER,
          basis: 'sqlLiteral',
          method: 'sql',
          file: schema.relativePath,
          line: key.line,
          matched: key.toTable,
        }),
        metadata: {
          foreignKey: true,
          ...(key.fromColumn !== null ? { fromColumn: key.fromColumn } : {}),
          ...(key.toColumn !== null ? { toColumn: key.toColumn } : {}),
        },
      });
    }

    return count;
  }
}
