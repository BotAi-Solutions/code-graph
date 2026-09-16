/**
 * `pnpm fixtures:build`
 *
 * Regenerates the checked-in SCIP fixtures from the sample repositories under
 * `test-repositories/`.
 *
 * The fixtures exist so the test suite can exercise the real parser, refiner,
 * builder and analyzers without spawning an indexer — the one genuinely
 * external step. scip-typescript is deterministic over unchanged sources, so a
 * regenerated fixture is byte-identical unless a sample actually changed, and a
 * dirty `git status` after running this is the signal to re-check the
 * expectations in the tests.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeCommandRunner, resolveExecutable } from '@ckg/scip';
import { parseEnv, scipEnvSchema } from '@ckg/shared';
import { loadEnvFile } from '@ckg/shared/node';

const SAMPLES = ['typescript-sample', 'express-postgres-sample'] as const;

const FIXTURE_DIR = 'packages/scip/tests/fixtures';

async function main(): Promise<void> {
  loadEnvFile();
  const env = parseEnv(scipEnvSchema, process.env);

  const executable = await resolveExecutable(env.SCIP_TYPESCRIPT_COMMAND, {
    searchRoots: [process.cwd()],
  });
  const runner = new NodeCommandRunner();

  for (const sample of SAMPLES) {
    const repository = path.resolve('test-repositories', sample);
    const output = path.resolve(FIXTURE_DIR, `${sample}.scip`);

    const result = await runner.run(
      executable,
      ['index', '--cwd', repository, '--output', output, '--infer-tsconfig', '--no-progress-bar'],
      { cwd: repository, timeoutMs: env.SCIP_INDEX_TIMEOUT_MS },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `scip-typescript failed for ${sample} (exit ${String(result.exitCode)}):\n${result.stderr}`,
      );
    }

    const bytes = await readFile(output);
    const checksum = createHash('sha256').update(bytes).digest('hex').slice(0, 16);

    process.stdout.write(
      `  ${sample.padEnd(28)} ${String(bytes.length).padStart(8)} bytes  sha256:${checksum}\n`,
    );
  }

  process.stdout.write('\nFixtures written to ' + FIXTURE_DIR + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
