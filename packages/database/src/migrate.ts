import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './client.js';

/**
 * A deliberately small forward-only migration runner: ordered `.sql` files, one
 * transaction each, recorded with a checksum so an edited migration is caught
 * instead of silently diverging. No rollback support — reverting means writing
 * a new migration.
 */

const MIGRATIONS_TABLE = 'schema_migrations';

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

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name        TEXT PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(db: Database): Promise<AppliedMigration[]> {
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
): Promise<MigrationStatus> {
  await ensureMigrationsTable(db);

  const available = await loadMigrations(dir);
  const applied = await readApplied(db);
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
  options: { dir?: string; onApply?: (name: string) => void } = {},
): Promise<MigrateResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  await ensureMigrationsTable(db);

  const available = await loadMigrations(dir);
  const applied = await readApplied(db);
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

    await db.transaction(async (tx) => {
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
