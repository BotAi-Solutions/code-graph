import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATION_LOCK_KEY,
  MigrationLockTimeoutError,
  createDatabase,
  getMigrationStatus,
  migrate,
} from '@ckg/database';
import type { Database } from '@ckg/database';
import { testDatabaseUrl } from './helpers/test-database.js';

/**
 * Two migration runners against one database, against a real PostgreSQL.
 *
 * The race this guards against: both runners read the bookkeeping table, both
 * see the same migration as pending, both run it, and the second fails inside
 * PostgreSQL's catalog with `duplicate key value violates unique constraint
 * "pg_class_relname_nsp_index"`.
 *
 * Made deterministic with a gate rather than with timing. The pending
 * migration first takes a share lock on a `gate` table that the test holds
 * exclusively, so the first runner to reach the migration stops there. The
 * test then waits until PostgreSQL itself shows where each runner is blocked:
 * with the advisory lock, one runner waits on the gate and the other waits on
 * the advisory lock. Without it, both would be waiting on the gate, inside the
 * same migration. Only then is the gate released.
 *
 * Everything happens in a schema of its own (`search_path` on the
 * connection), so the runner's bookkeeping table and the probe migration never
 * touch the real `schema_migrations`. The suite runs only against
 * `TEST_DATABASE_URL` (see `helpers/test-database.ts`), never `DATABASE_URL`.
 */

const CONNECTION_STRING = testDatabaseUrl('migration concurrency integration');
const RUN = randomUUID().slice(0, 8);
const SCHEMA = `ckg_migrate_race_${RUN}`;

const suite = CONNECTION_STRING ? describe : describe.skip;

/** A connection whose unqualified names resolve to the test's own schema. */
function inSchema(applicationName: string): Database {
  const separator = (CONNECTION_STRING as string).includes('?') ? '&' : '?';
  return createDatabase({
    connectionString: `${CONNECTION_STRING as string}${separator}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`,
    maxConnections: 2,
    applicationName,
  });
}

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ckg-migrations-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(directory, name), sql, 'utf8');
  return directory;
}

const BASE = { '0001_base.sql': 'CREATE TABLE IF NOT EXISTS base_table (id int);' };
const PENDING = {
  ...BASE,
  // Shaped like 0006: IF NOT EXISTS DDL, which is not safe against a
  // concurrent creation. The gate makes the first runner stop inside it.
  '0002_pending.sql': [
    'LOCK TABLE gate IN ACCESS SHARE MODE;',
    'CREATE TABLE IF NOT EXISTS race_probe (id int);',
    'CREATE INDEX IF NOT EXISTS race_probe_id ON race_probe (id);',
  ].join('\n'),
};

suite('migrate() with concurrent runners, against PostgreSQL', () => {
  let admin: Database;
  const directories: string[] = [];

  const dir = async (files: Record<string, string>): Promise<string> => {
    const directory = await migrationsDir(files);
    directories.push(directory);
    return directory;
  };

  beforeAll(async () => {
    admin = inSchema(`ckg-race-admin-${RUN}`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query('CREATE TABLE gate (id int)');
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  });

  /** Ungranted lock requests from the two runners, by lock type. */
  async function waits(names: string[]): Promise<string[]> {
    const result = await admin.query<{ locktype: string }>(
      `SELECT l.locktype
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.application_name = ANY($1::text[])
        ORDER BY l.locktype`,
      [names],
    );
    return result.rows.map((row) => row.locktype);
  }

  it('lets exactly one of two runners apply a pending migration; the other waits, then finds nothing to do', async () => {
    // A database with one migration applied and one pending.
    const setup = inSchema(`ckg-race-setup-${RUN}`);
    await migrate(setup, { dir: await dir(BASE) });
    await setup.close();
    const pending = await dir(PENDING);

    const names = [`ckg-race-a-${RUN}`, `ckg-race-b-${RUN}`];
    const runners = names.map(inSchema);

    // Hold the gate shut for the length of the race.
    let openGate!: () => void;
    const gateOpened = new Promise<void>((resolve) => (openGate = resolve));
    let gateClosed!: () => void;
    const gateIsClosed = new Promise<void>((resolve) => (gateClosed = resolve));
    const holding = admin.withSession(async (session) => {
      await session.transaction(async (tx) => {
        await tx.query('LOCK TABLE gate IN ACCESS EXCLUSIVE MODE');
        gateClosed();
        await gateOpened;
      });
    });
    await gateIsClosed;

    try {
      const results = runners.map((runner) => migrate(runner, { dir: pending }));

      // Wait until PostgreSQL shows both runners blocked, and where.
      let observed: string[] = [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        observed = await waits(names);
        if (observed.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // One inside the migration, waiting on the gate; one outside it, waiting
      // on the migration lock. Without the lock this reads ['relation', 'relation'].
      expect(observed).toEqual(['advisory', 'relation']);

      openGate();
      const settled = await Promise.allSettled(results);

      expect(settled.map((entry) => entry.status)).toEqual(['fulfilled', 'fulfilled']);
      const applied = settled
        .map((entry) => (entry.status === 'fulfilled' ? entry.value.applied : []))
        .sort((a, b) => b.length - a.length);
      expect(applied).toEqual([['0002_pending.sql'], []]);

      const recorded = await admin.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
      expect(recorded.rows.map((row) => row.name)).toEqual(['0001_base.sql', '0002_pending.sql']);
    } finally {
      openGate();
      await holding;
      for (const runner of runners) await runner.close();
    }
  }, 30_000);

  it('applies nothing the second time', async () => {
    const runner = inSchema(`ckg-race-again-${RUN}`);
    try {
      const result = await migrate(runner, { dir: await dir(PENDING) });
      expect(result).toEqual({ applied: [], alreadyApplied: 2 });
      expect((await getMigrationStatus(runner, await dir(PENDING))).pending).toEqual([]);
    } finally {
      await runner.close();
    }
  });

  it('reports a failing migration, records nothing for it, and releases the lock', async () => {
    const runner = inSchema(`ckg-race-fail-${RUN}`);
    try {
      await expect(
        migrate(runner, { dir: await dir({ ...PENDING, '0003_broken.sql': 'CREATE TABLE half_done (id int); SELECT 1 / 0;' }) }),
      ).rejects.toThrow(/division by zero/);

      const recorded = await admin.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
      expect(recorded.rows.map((row) => row.name)).not.toContain('0003_broken.sql');
      const halfDone = await admin.query<{ exists: boolean }>(
        `SELECT to_regclass('${SCHEMA}.half_done') IS NOT NULL AS exists`,
      );
      expect(halfDone.rows[0]?.exists).toBe(false);

      // Another session can take the lock at once: the failure did not keep it.
      const free = await admin.withSession(async (session) => {
        const taken = await session.query<{ taken: boolean }>(
          'SELECT pg_try_advisory_lock($1::bigint) AS taken',
          [MIGRATION_LOCK_KEY],
        );
        if (taken.rows[0]?.taken) await session.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
        return taken.rows[0]?.taken;
      });
      expect(free).toBe(true);
    } finally {
      await runner.close();
    }
  });

  it('gives up with a clear error when another runner holds the lock too long, applying nothing', async () => {
    const runner = inSchema(`ckg-race-timeout-${RUN}`);
    try {
      await admin.withSession(async (session) => {
        await session.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
        try {
          await expect(
            migrate(runner, {
              dir: await dir({ ...PENDING, '0004_late.sql': 'CREATE TABLE late_table (id int);' }),
              lockTimeoutMs: 200,
            }),
          ).rejects.toThrow(MigrationLockTimeoutError);
        } finally {
          await session.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
        }
      });
      const late = await admin.query<{ exists: boolean }>(`SELECT to_regclass('${SCHEMA}.late_table') IS NOT NULL AS exists`);
      expect(late.rows[0]?.exists).toBe(false);
    } finally {
      await runner.close();
    }
  });
});
