import pg from 'pg';
import type { DatabaseEnv } from '@ckg/shared';

const { Pool, types } = pg;

/**
 * `bigint` (OID 20) arrives as a string by default so that values beyond
 * Number.MAX_SAFE_INTEGER survive. Every count we issue is a row count that
 * comfortably fits in a JS number, so parse it eagerly and keep call sites
 * free of `Number(...)` noise.
 */
types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

export type QueryParam = unknown;

export interface QueryResult<TRow> {
  rows: TRow[];
  rowCount: number;
}

/**
 * The only surface the rest of the codebase sees. Repositories depend on this
 * interface rather than on `pg`, which keeps them trivially fakeable and means
 * a transaction and a pool are interchangeable.
 */
export interface Queryable {
  query<TRow extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: QueryParam[],
  ): Promise<QueryResult<TRow>>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

function wrap(executor: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<TRow extends pg.QueryResultRow = pg.QueryResultRow>(
      sql: string,
      params: QueryParam[] = [],
    ): Promise<QueryResult<TRow>> {
      const result = await executor.query<TRow>(sql, params as unknown[]);

      // A parameterless statement goes over the simple query protocol, which
      // allows several statements in one string and answers with one result
      // per statement. Migrations rely on that; report the last one.
      if (Array.isArray(result)) {
        const last = result.at(-1) as pg.QueryResult<TRow> | undefined;
        return { rows: last?.rows ?? [], rowCount: last?.rowCount ?? last?.rows.length ?? 0 };
      }

      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
  };
}

export interface CreateDatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  /** Applied to every new connection; useful for statement timeouts in prod. */
  applicationName?: string;
}

export function createDatabase(options: CreateDatabaseOptions): Database {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? 'code-knowledge-graph',
  });

  // A pool-level error would otherwise crash the process as an unhandled
  // 'error' event when a backend connection drops.
  pool.on('error', () => {
    /* handled by the caller's next query, which will reconnect */
  });

  const base = wrap(pool);

  return {
    query: base.query,

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },

    async ping(): Promise<boolean> {
      const result = await base.query<{ ok: number }>('SELECT 1 AS ok');
      return result.rows[0]?.ok === 1;
    },
  };
}

export function createDatabaseFromEnv(env: DatabaseEnv, applicationName?: string): Database {
  return createDatabase({
    connectionString: env.DATABASE_URL,
    maxConnections: env.DATABASE_POOL_MAX,
    ...(applicationName ? { applicationName } : {}),
  });
}
