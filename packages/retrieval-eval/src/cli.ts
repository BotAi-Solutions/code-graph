import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RETRIEVAL_CASES } from './cases.js';
import { HttpRetrievalClient } from './client.js';
import { formatReport, toMachineReport } from './report.js';
import { runEvaluation } from './run.js';

/**
 * `pnpm evaluate:retrieval [--json <file>] [--case <id>] [--api <url>]`
 *
 * Needs a running API with the fixture repositories indexed — it is a client,
 * not a pipeline, and that is the point: what it measures is what any other
 * consumer of the public interface would get.
 *
 * ## Why it does not fail on a failing case
 *
 * Failures here are findings, not regressions. The dataset deliberately
 * contains cases that retrieval cannot answer yet, because the list of those is
 * the output worth having. `--fail-on-error` covers the different situation
 * where the run itself could not happen — no API, no indexed fixture — which is
 * a broken invocation rather than a result.
 */

interface Options {
  jsonPath: string | null;
  only: string[];
  apiUrl: string;
  failOnError: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    jsonPath: null,
    only: [],
    apiUrl: process.env.RETRIEVAL_EVAL_API_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`,
    failOnError: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.jsonPath = argv[index + 1] ?? null;
    if (argument === '--case') {
      const id = argv[index + 1];
      if (id !== undefined) options.only.push(id);
    }
    if (argument === '--api') options.apiUrl = argv[index + 1] ?? options.apiUrl;
    if (argument === '--fail-on-error') options.failOnError = true;
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = new HttpRetrievalClient(options.apiUrl.replace(/\/+$/, ''));

  const run = await runEvaluation(client, RETRIEVAL_CASES, {
    ...(options.only.length > 0 ? { only: options.only } : {}),
  });

  process.stdout.write(`${formatReport(run)}\n`);

  if (options.jsonPath !== null) {
    const target = path.resolve(options.jsonPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(toMachineReport(run), null, 2)}\n`, 'utf8');
    process.stdout.write(`\nWrote ${target}\n`);
  }

  // A case that could not run at all — no project, no API — is a broken
  // invocation, and is worth distinguishing from a case that ran and failed.
  const unrunnable = run.results.filter((result) => result.error !== undefined);
  if (unrunnable.length > 0) {
    process.stderr.write(
      `\n${String(unrunnable.length)} case(s) could not be run. Is the API running at ${options.apiUrl}, with the fixtures indexed?\n`,
    );
    if (options.failOnError) process.exit(1);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
