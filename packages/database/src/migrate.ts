import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database, Queryable, Session } from './client.js';

/**
 * A deliberately small forward-only migration runner: ordered `.sql` files, one
 * transaction each, recorded with a checksum so an edited migration is caught
 * instead of silently diverging. No rollback support — reverting means writing
 * a new migration.
 *
 * ## One runner at a time
 *
 * Reading what has been applied and applying what has not are two steps. Two
 * runners interleaving them — two test files, two `pnpm db:migrate`, the
 * benchmark beside a developer — both see a migration as pending, both run it,
 * and the second fails inside PostgreSQL's catalog (`duplicate key value
 * violates unique constraint "pg_class_relname_nsp_index"`), because
 * `IF NOT EXISTS` is not safe against a concurrent creation either.
 *
 * So every runner first takes a session-level advisory lock with one fixed
 * key, on one dedicated connection, and holds it from creating the bookkeeping
 * table through the last migration. A second runner waits, then reads the
 * bookkeeping table the first one finished writing, and finds nothing to do.
 * Advisory locks are per database, so runners against different databases on
 * one server never wait for each other, and nothing but this runner uses the
 * key. The lock is released explicitly on success and failure; if the process
 * dies, PostgreSQL releases it when the connection closes.
 */

const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * The advisory lock key every migration runner takes: the first eight bytes of
 * sha256("code-knowledge-graph:schema_migrations") as a signed 64-bit integer.
 * Fixed forever: a runner using a different key would not exclude this one.
 */
export const MIGRATION_LOCK_KEY = '4342523475488893602';

/** How long a runner waits for another to finish before giving up. */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 300_000;

export class MigrationLockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `another migration runner held the migration lock for longer than ${String(timeoutMs)} ms; ` +
        'nothing was applied. Retry once it has finished.',
    );
    this.name = 'MigrationLockTimeoutError';
  }
}

export interface MigrationLockOptions {
  /** Wait at most this long for another runner. Defaults to five minutes. */
  lockTimeoutMs?: number;
}

/**
 * Runs `fn` holding the migration lock on one connection.
 *
 * The wait is bounded with `lock_timeout`, which PostgreSQL applies to
 * advisory locks; the setting is reset as soon as the lock is held, so it
 * never limits the migrations themselves.
 */
async function withMigrationLock<T>(
  db: Database,
  options: MigrationLockOptions,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;

  return db.withSession(async (session) => {
    await session.query(`SELECT set_config('lock_timeout', $1, false)`, [`${String(timeoutMs)}ms`]);
    try {
      await session.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    } catch (error) {
      // 55P03 lock_not_available: the wait ran out. Anything else is not ours to rename.
      if ((error as { code?: string }).code === '55P03') throw new MigrationLockTimeoutError(timeoutMs);
      throw error;
    }
    // Back to the server's or role's own value: the connection returns to the pool.
    await session.query('RESET lock_timeout');

    try {
      return await fn(session);
    } finally {
      await session.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
    }
  });
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: string[];
  drifted: string[];
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function ensureMigrationsTable(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name        TEXT PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(db: Queryable): Promise<AppliedMigration[]> {
  const result = await db.query<{ name: string; checksum: string; applied_at: Date }>(
    `SELECT name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  return result.rows.map((row) => ({
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at.toISOString(),
  }));
}

export async function getMigrationStatus(
  db: Database,
  dir: string = MIGRATIONS_DIR,
  options: MigrationLockOptions = {},
): Promise<MigrationStatus> {
  // Under the lock too: it creates the bookkeeping table, and a status read
  // while a runner is mid-way would describe a state that is about to change.
  return withMigrationLock(db, options, async (session) => {
    await ensureMigrationsTable(session);
    return statusOf(await loadMigrations(dir), await readApplied(session));
  });
}

function statusOf(available: MigrationFile[], applied: AppliedMigration[]): MigrationStatus {
  const appliedByName = new Map(applied.map((row) => [row.name, row]));

  const pending: string[] = [];
  const drifted: string[] = [];

  for (const migration of available) {
    const record = appliedByName.get(migration.name);
    if (!record) {
      pending.push(migration.name);
    } else if (record.checksum !== migration.checksum) {
      drifted.push(migration.name);
    }
  }

  return { applied, pending, drifted };
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migrate(
  db: Database,
  options: { dir?: string; onApply?: (name: string) => void } & MigrationLockOptions = {},
): Promise<MigrateResult> {
  return withMigrationLock(db, options, (session) => applyPending(session, options));
}

/** Everything `migrate` does, on the session that holds the lock. */
async function applyPending(
  session: Session,
  options: { dir?: string; onApply?: (name: string) => void },
): Promise<MigrateResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  await ensureMigrationsTable(session);

  const available = await loadMigrations(dir);
  const applied = await readApplied(session);
  const appliedByName = new Map(applied.map((row) => [row.name, row]));

  const drifted = available.filter((migration) => {
    const record = appliedByName.get(migration.name);
    return record !== undefined && record.checksum !== migration.checksum;
  });

  if (drifted.length > 0) {
    throw new Error(
      `Applied migrations were modified after the fact: ${drifted
        .map((migration) => migration.name)
        .join(', ')}. Add a new migration instead of editing an applied one.`,
    );
  }

  const newlyApplied: string[] = [];

  for (const migration of available) {
    if (appliedByName.has(migration.name)) continue;

    await session.transaction(async (tx) => {
      await tx.query(migration.sql);
      await tx.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`, [
        migration.name,
        migration.checksum,
      ]);
    });

    newlyApplied.push(migration.name);
    options.onApply?.(migration.name);
  }

  return { applied: newlyApplied, alreadyApplied: appliedByName.size };
}
