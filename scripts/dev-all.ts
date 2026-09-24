import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm dev:all` — everything an MCP client needs, in one terminal.
 *
 *   PostgreSQL ─▶ build ─▶ migrations ─▶ API + worker (+ web) ─▶ health check
 *
 * An orchestrator, not a second way to run anything. Each step is a command
 * this repository already has:
 *
 * - PostgreSQL is `docker compose up -d --wait postgres`, the service in
 *   `docker-compose.yml`, and only when nothing is listening at `DATABASE_URL`
 *   already — a locally installed server is used as it is.
 * - The build is `pnpm build:packages`, migrations are `pnpm db:migrate`.
 * - Each service is its own package's `dev` script, the same ones `pnpm dev`
 *   runs, so there is still exactly one definition of how the API starts.
 *
 * Failures are loud. A step that fails stops the whole command with its exit
 * code; a service that exits while the others run takes them down with it and
 * says which one it was. Nothing is restarted behind your back.
 *
 * Ctrl+C stops the services. PostgreSQL is left running — it holds your data
 * and takes a while to start — and the banner says how to stop it.
 */

const WORKSPACE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export interface ServiceSpec {
  name: string;
  command: string;
  args: string[];
}

export interface DevAllOptions {
  web: boolean;
}

/** The long-running services, each started by its own package's `dev` script. */
export function plannedServices(options: DevAllOptions): ServiceSpec[] {
  const services: ServiceSpec[] = [
    { name: 'api', command: 'pnpm', args: ['--filter', '@ckg/api', 'dev'] },
    { name: 'worker', command: 'pnpm', args: ['--filter', '@ckg/worker', 'dev'] },
  ];
  if (options.web) services.push({ name: 'web', command: 'pnpm', args: ['--filter', '@ckg/web', 'dev'] });
  return services;
}

/**
 * The one-off steps before any service starts, in order. The build comes
 * first because the migration runner imports the built workspace packages.
 */
export const SETUP_STEPS: ServiceSpec[] = [
  { name: 'build', command: 'pnpm', args: ['build:packages'] },
  { name: 'migrate', command: 'pnpm', args: ['db:migrate'] },
];

export const POSTGRES_UP: ServiceSpec = {
  name: 'postgres',
  command: 'docker',
  args: ['compose', 'up', '-d', '--wait', 'postgres'],
};

export function parseOptions(argv: readonly string[]): DevAllOptions {
  return { web: !argv.includes('--no-web') };
}

/** Where the database is, from `DATABASE_URL`. Null when it is not a URL we can probe. */
export function databaseTarget(databaseUrl: string | undefined): { host: string; port: number } | null {
  if (!databaseUrl) return null;
  try {
    const url = new URL(databaseUrl);
    return { host: url.hostname || 'localhost', port: url.port ? Number(url.port) : 5432 };
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// --- running --------------------------------------------------------------

const COLOURS: Record<string, string> = {
  postgres: '\u001b[34m',
  migrate: '\u001b[35m',
  build: '\u001b[35m',
  api: '\u001b[32m',
  worker: '\u001b[33m',
  web: '\u001b[36m',
  'dev:all': '\u001b[1m',
};
const RESET = '\u001b[0m';

function label(name: string): string {
  const tag = `[${name}]`.padEnd(10);
  return process.stdout.isTTY ? `${COLOURS[name] ?? ''}${tag}${RESET}` : tag;
}

function say(message: string): void {
  process.stdout.write(`${label('dev:all')} ${message}\n`);
}

function pipeLines(child: ChildProcess, name: string): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      process.stdout.write(`${label(name)} ${line}\n`);
    });
  }
}

function start(spec: ServiceSpec, detached: boolean): ChildProcess {
  const child = spawn(spec.command, spec.args, {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, FORCE_COLOR: process.stdout.isTTY ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it stops what it started: pnpm runs
    // tsx, which runs node, and a signal to pnpm alone would orphan both.
    detached: detached && process.platform !== 'win32',
  });
  pipeLines(child, spec.name);
  return child;
}

/** Runs a one-off step to completion. Rejects, naming the step, if it fails. */
function runStep(spec: ServiceSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = start(spec, false);
    child.on('error', (error) => {
      reject(new Error(`${spec.name}: could not run ${spec.command} (${error.message})`));
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${spec.name} failed: \`${[spec.command, ...spec.args].join(' ')}\` exited with ${String(code)}`));
    });
  });
}

function reachable(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function ensurePostgres(): Promise<string> {
  const target = databaseTarget(process.env.DATABASE_URL);
  if (!target) {
    throw new Error('DATABASE_URL is not set or is not a URL. Copy .env.example to .env and adjust it.');
  }

  const where = `${target.host}:${String(target.port)}`;
  if (await reachable(target.host, target.port)) {
    say(`postgres already listening at ${where}; using it as it is.`);
    return `${where} (already running; not managed by dev:all)`;
  }

  if (!LOCAL_HOSTS.has(target.host)) {
    throw new Error(`Nothing is listening at ${where}, and it is not a local address dev:all could start. Start that database, or point DATABASE_URL elsewhere.`);
  }

  const composePort = process.env.POSTGRES_PORT ?? '5432';
  if (composePort !== String(target.port)) {
    throw new Error(
      `Nothing is listening at ${where}, and docker compose would publish PostgreSQL on port ${composePort} (POSTGRES_PORT). Make POSTGRES_PORT and the port in DATABASE_URL agree.`,
    );
  }

  say(`nothing listening at ${where}; starting PostgreSQL with docker compose…`);
  try {
    await runStep(POSTGRES_UP);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        '  Is Docker running? Start Docker Desktop (or your Docker daemon) and try again,\n' +
        '  or run PostgreSQL yourself and point DATABASE_URL at it.',
    );
  }

  if (!(await reachable(target.host, target.port, 5_000))) {
    throw new Error(`docker compose reported PostgreSQL healthy, but nothing answers at ${where}.`);
  }
  return `${where} (docker compose service "postgres"; stop it with \`docker compose stop postgres\`)`;
}

/**
 * Refuses to start next to something already holding a service's port.
 *
 * Not a nicety. `tsx watch` outlives the process it runs, so an API that dies
 * with EADDRINUSE leaves its watcher up and no exit for this script to see —
 * and the health check would then pass against whatever else owns the port,
 * reporting as running a service that is not. Checking first is the only way
 * to say so.
 */
async function assertPortsFree(ports: Array<{ name: string; port: number; variable: string }>): Promise<void> {
  const taken: string[] = [];
  for (const { name, port, variable } of ports) {
    if ((await reachable('127.0.0.1', port)) || (await reachable('localhost', port))) {
      taken.push(`  ${name}: port ${String(port)} is already in use (${variable})`);
    }
  }
  if (taken.length > 0) {
    throw new Error(
      `Cannot start: \n${taken.join('\n')}\n` +
        '  Another copy is probably running (`pnpm dev`, `pnpm dev:api`, `pnpm dev:web`). Stop it, or choose a free port.',
    );
  }
}

async function waitForApi(port: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

async function main(): Promise<void> {
  const envFile = path.join(WORKSPACE_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  else say('no .env found; using the environment and built-in defaults (see .env.example).');

  const options = parseOptions(process.argv.slice(2));
  const apiPort = process.env.PORT ?? '3000';

  let postgres: string;
  try {
    await assertPortsFree([
      { name: 'api', port: Number(apiPort), variable: 'PORT' },
      ...(options.web ? [{ name: 'web', port: 5173, variable: 'the Vite dev server port' }] : []),
    ]);
    postgres = await ensurePostgres();
    for (const step of SETUP_STEPS) {
      say(`${step.name}: ${[step.command, ...step.args].join(' ')}`);
      await runStep(step);
    }
  } catch (error) {
    say(`\u001b[31m${error instanceof Error ? error.message : String(error)}${RESET}`);
    process.exit(1);
  }

  const services = plannedServices(options).map((spec) => ({ spec, child: start(spec, true) }));
  let stopping = false;

  const stopAll = async (exitCode: number): Promise<never> => {
    if (!stopping) {
      stopping = true;
      say('stopping services…');
      for (const { child } of services) signalGroup(child, 'SIGTERM');
      const exited = Promise.all(
        services.map(
          ({ child }) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) resolve();
              else child.once('close', () => resolve());
            }),
        ),
      );
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8_000));
      if ((await Promise.race([exited, timeout])) === 'timeout') {
        for (const { child } of services) signalGroup(child, 'SIGKILL');
      }
      say('stopped. PostgreSQL is still running (`docker compose stop postgres` stops it).');
    }
    process.exit(exitCode);
  };

  for (const { spec, child } of services) {
    child.on('error', (error) => {
      say(`\u001b[31m${spec.name} could not start: ${error.message}${RESET}`);
      void stopAll(1);
    });
    child.on('close', (code, signal) => {
      if (stopping) return;
      say(`\u001b[31m${spec.name} exited unexpectedly (${signal ?? `code ${String(code)}`}); stopping the rest.${RESET}`);
      void stopAll(typeof code === 'number' && code !== 0 ? code : 1);
    });
  }

  process.on('SIGINT', () => void stopAll(0));
  process.on('SIGTERM', () => void stopAll(0));

  const healthy = await waitForApi(apiPort, 60_000);
  if (stopping) return;
  if (!healthy) {
    say(`\u001b[31mthe API did not answer http://localhost:${apiPort}/health within 60s; see its output above.${RESET}`);
    await stopAll(1);
    return;
  }

  const lines = [
    '',
    'CodeRAG is running:',
    `  postgres  ${postgres}`,
    `  api       http://localhost:${apiPort}   (docs: /docs, health: /health)`,
    '  worker    claiming indexing jobs from PostgreSQL',
    ...(options.web ? ['  web       http://localhost:5173'] : []),
    '  mcp       launched by your MCP client — see .mcp.json and docs/mcp.md',
    '',
    'Ctrl+C stops the services.',
    '',
  ];
  for (const line of lines) say(line);
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPoint !== null && fileURLToPath(import.meta.url) === entryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
