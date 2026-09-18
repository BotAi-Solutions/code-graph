import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatReport, toMachineReport } from './report.js';
import { runBenchmark } from './run.js';

/**
 * `pnpm benchmark [--json <file>] [--fail-on-regression]`
 *
 * Prints the report, and optionally writes the machine-readable one.
 *
 * ## Why it does not fail the build by default
 *
 * A benchmark that fails CI on its first bad day gets disabled on its second.
 * The default is to report: the numbers go to stdout, the JSON goes wherever CI
 * keeps artefacts, and a human decides whether a two-point drop in
 * documentation recall is a regression or a better fixture.
 *
 * `--fail-on-regression` turns that off and exits non-zero on any unmet
 * expectation, which is what a repository with a stable fixture should
 * eventually run. There is no threshold flag on purpose: a threshold is a
 * number somebody picks to make a build green, and the expectations in the
 * ground truth are the thresholds.
 */

interface Options {
  jsonPath: string | null;
  failOnRegression: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { jsonPath: null, failOnRegression: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    // `pnpm benchmark -- --json out.json` forwards the separator as an
    // argument. Skipping it is cheaper than telling everyone not to type it.
    if (argument === '--') continue;

    if (argument === '--fail-on-regression') {
      options.failOnRegression = true;
      continue;
    }
    if (argument === '--json') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--json needs a file path');
      }
      options.jsonPath = next;
      index += 1;
      continue;
    }
    if (argument !== undefined && argument.startsWith('--json=')) {
      options.jsonPath = argument.slice('--json='.length);
      continue;
    }
    if (argument !== undefined) throw new Error(`unknown argument: ${argument}`);
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const run = await runBenchmark();

  process.stdout.write(formatReport(run.results));

  for (const timing of run.timings) {
    process.stdout.write(
      `Assembled ${timing.fixture} in ${String(timing.durationMs)} ms\n`,
    );
  }

  if (options.jsonPath !== null) {
    const report = toMachineReport(run.results);
    const target = path.resolve(options.jsonPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nMachine-readable report written to ${target}\n`);
  }

  if (!run.passed) {
    process.stdout.write(
      options.failOnRegression
        ? '\nExpectations were not met; failing as requested.\n'
        : '\nExpectations were not met. Re-run with --fail-on-regression to make this an error.\n',
    );
    if (options.failOnRegression) process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
