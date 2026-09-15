/**
 * `pnpm setup:scip`
 *
 * Verifies that the SCIP indexers the platform needs are reachable, and prints
 * what to do when one is missing. Run it after cloning, and whenever an
 * analysis fails with SCIP_INDEXER_NOT_FOUND.
 */
import { NodeCommandRunner, resolveExecutable } from '@ckg/scip';
import { parseEnv, scipEnvSchema } from '@ckg/shared';

interface IndexerCheck {
  language: string;
  command: string;
  installHint: string;
}

async function check(indexer: IndexerCheck): Promise<boolean> {
  const executable = await resolveExecutable(indexer.command, { searchRoots: [process.cwd()] });
  const runner = new NodeCommandRunner();

  try {
    const result = await runner.run(executable, ['--version'], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });

    if (result.exitCode === 0) {
      const version = result.stdout.trim() || result.stderr.trim() || 'unknown version';
      process.stdout.write(`  ok        ${indexer.language.padEnd(12)} ${executable} (${version})\n`);
      return true;
    }

    process.stdout.write(
      `  FAILED    ${indexer.language.padEnd(12)} ${executable} exited with ${String(result.exitCode)}\n`,
    );
  } catch {
    process.stdout.write(`  MISSING   ${indexer.language.padEnd(12)} ${indexer.command}\n`);
  }

  process.stdout.write(`            -> ${indexer.installHint}\n`);
  return false;
}

async function main(): Promise<void> {
  const env = parseEnv(scipEnvSchema, process.env);

  const indexers: IndexerCheck[] = [
    {
      language: 'typescript',
      command: env.SCIP_TYPESCRIPT_COMMAND,
      installHint:
        'pnpm add -Dw @sourcegraph/scip-typescript   (or set SCIP_TYPESCRIPT_COMMAND to an absolute path)',
    },
  ];

  process.stdout.write('Checking SCIP indexers\n');
  const results = await Promise.all(indexers.map(check));

  if (results.every(Boolean)) {
    process.stdout.write('\nAll configured indexers are available.\n');
    return;
  }

  process.stdout.write('\nAt least one indexer is unavailable; analyses for it will fail.\n');
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
