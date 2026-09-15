/**
 * `pnpm db:migrate` / `pnpm db:status`.
 *
 * Reads DATABASE_URL through the shared env schema so the CLI fails the same
 * way the services do when configuration is missing.
 */
import { databaseEnvSchema, parseEnv } from '@ckg/shared';
import { loadEnvFile } from '@ckg/shared/node';
import { createDatabaseFromEnv } from './client.js';
import { getMigrationStatus, migrate } from './migrate.js';

async function main(): Promise<void> {
  loadEnvFile();

  const command = process.argv[2] ?? 'up';
  const env = parseEnv(databaseEnvSchema, process.env);
  const db = createDatabaseFromEnv(env, 'ckg-migrate');

  try {
    if (command === 'up') {
      const result = await migrate(db, {
        onApply: (name) => process.stdout.write(`applied ${name}\n`),
      });
      if (result.applied.length === 0) {
        process.stdout.write(`database up to date (${result.alreadyApplied} migrations)\n`);
      }
      return;
    }

    if (command === 'status') {
      const status = await getMigrationStatus(db);
      process.stdout.write(`applied: ${status.applied.map((m) => m.name).join(', ') || '(none)'}\n`);
      process.stdout.write(`pending: ${status.pending.join(', ') || '(none)'}\n`);
      if (status.drifted.length > 0) {
        process.stdout.write(`DRIFTED: ${status.drifted.join(', ')}\n`);
        process.exitCode = 1;
      }
      return;
    }

    process.stderr.write(`unknown command "${command}" (expected: up | status)\n`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
