/**
 * `pnpm benchmark:perf [options]`
 *
 * The performance benchmark: indexes pinned public repositories with the
 * production pipeline — several initial indexes and several re-indexes each —
 * then asks the graph API a fixed set of questions about each one. Every run is
 * kept, failed and incomplete ones included.
 *
 *   --manifest <file>        default benchmarks/repositories.json
 *   --repos <a,b>            only these repositories (manifest ids)
 *   --initial-runs <n>       initial-index samples per repository (default 5)
 *   --reindex-runs <n>       re-index runs per repository (default 5; --warm is an alias)
 *   --query-warmup <n>       discarded warm-up passes per round (default 2)
 *   --query-iterations <n>   measured passes per round (default 20; 0 skips queries)
 *   --query-rounds <n>       rounds, each against a fresh API process (default 2)
 *   --no-settle              do not VACUUM (ANALYZE) before initial indexes and queries
 *   --store <postgres|in-memory>
 *                            in-memory persists nothing and measures no database;
 *                            for smoke tests only (default postgres)
 *   --out <dir>              default .benchmarks/results/<timestamp>
 *   --checkouts <dir>        default ~/.cache/ckg-benchmark/checkouts — must have no
 *                            node_modules in any parent directory
 *   --scip-timeout <ms>      default 1800000
 *   --verify-only            check that every pin resolves, then stop
 *   --keep-previous          keep earlier benchmark projects in the database
 *   --migrate                apply pending migrations to the benchmark database
 *   --allow-shared-database  allow BENCHMARK_DATABASE_URL to equal DATABASE_URL
 *
 * The database is `BENCHMARK_DATABASE_URL`, a database used for nothing else:
 * the harness creates projects in it, vacuums its graph tables and, unless
 * `--keep-previous`, deletes the projects earlier invocations created (names
 * starting `perf:`).
 *
 * ## Initial index and re-index
 *
 * - **initial-index**: the project held no graph, so persistence inserts into
 *   an empty project. Each sample gets a new project; the previous sample's
 *   project is deleted and, unless `--no-settle`, the graph tables are vacuumed
 *   and analysed first, so every sample starts from a comparable database.
 * - **re-index**: the project held the previous run's graph, which persistence
 *   deletes and replaces. Not vacuumed in between: dead rows accumulate as they
 *   would in use, and the database state before each run is recorded.
 *
 * The kind is decided by the database, not by the run's position. Every run is
 * a new process. Neither the OS page cache nor PostgreSQL's buffer cache is
 * reset — that needs privileges the harness does not take — and every record
 * says so. Nothing here is a cold-cache measurement.
 *
 * ## Checkouts live outside the workspace
 *
 * TypeScript loads `@types/*` from every parent directory's `node_modules`. A
 * checkout inside this workspace therefore indexes against the workspace's own
 * `@types/node`: measured on express, 2,791 references resolved into it that
 * do not resolve outside. The harness refuses a checkouts directory with any
 * `node_modules` above it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnvFile } from '@ckg/shared/node';
import {
  ProjectRepository,
  createDatabase,
  getMigrationStatus,
  migrate,
  type Database,
} from '@ckg/database';
import { resolveExecutable } from '@ckg/scip';
import {
  PERF_REPORT_SCHEMA,
  QUERY_CSV_COLUMNS,
  RUN_CSV_COLUMNS,
  captureEnvironment,
  execProbe,
  loadManifest,
  planQueries,
  runQueries,
  selectRepositories,
  seriesOf,
  summarizeQueries,
  summarizeRuns,
  toCsv,
  type DatabaseInfo,
  type DatabaseSize,
  type DatabaseState,
  type IndexRunOutput,
  type ManifestRepository,
  type PerfReport,
  type PreparationRecord,
  type QueryRecord,
  type QueryTarget,
  type QueryWorkloadRecord,
  type RepositoryFacts,
  type RunRecord,
  type SettleStep,
} from '@ckg/benchmark';
import type { IndexRunSpec } from './perf-index-once.js';

const WORKSPACE = path.resolve(new URL('..', import.meta.url).pathname);
const TSX = path.join(WORKSPACE, 'node_modules/.bin/tsx');
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const GRAPH_TABLES = ['code_nodes', 'code_edges', 'analysis_jobs'];

interface Options {
  manifest: string;
  repos: string[] | null;
  initialRuns: number;
  reindexRuns: number;
  queryWarmup: number;
  queryIterations: number;
  queryRounds: number;
  settle: boolean;
  store: 'postgres' | 'in-memory';
  out: string;
  checkouts: string;
  scipTimeoutMs: number;
  verifyOnly: boolean;
  keepPrevious: boolean;
  migrate: boolean;
  allowSharedDatabase: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    manifest: path.join(WORKSPACE, 'benchmarks/repositories.json'),
    repos: null,
    initialRuns: 5,
    reindexRuns: 5,
    queryWarmup: 2,
    queryIterations: 20,
    queryRounds: 2,
    settle: true,
    store: 'postgres',
    out: path.join(WORKSPACE, '.benchmarks/results', new Date().toISOString().replace(/[:.]/g, '-')),
    checkouts: path.join(homedir(), '.cache', 'ckg-benchmark', 'checkouts'),
    scipTimeoutMs: 1_800_000,
    verifyOnly: false,
    keepPrevious: false,
    migrate: false,
    allowSharedDatabase: false,
  };

  const value = (index: number, name: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
    return next;
  };
  const count = (raw: string, name: string, min: number): number => {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${name} must be an integer >= ${String(min)}`);
    return parsed;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--':
        break;
      case '--manifest':
        options.manifest = path.resolve(value(index, argument));
        index += 1;
        break;
      case '--repos':
        options.repos = value(index, argument).split(',').map((id) => id.trim()).filter(Boolean);
        index += 1;
        break;
      case '--initial-runs':
        options.initialRuns = count(value(index, argument), argument, 1);
        index += 1;
        break;
      case '--reindex-runs':
      case '--warm':
        options.reindexRuns = count(value(index, argument), argument, 0);
        index += 1;
        break;
      case '--query-warmup':
        options.queryWarmup = count(value(index, argument), argument, 0);
        index += 1;
        break;
      case '--query-iterations':
        options.queryIterations = count(value(index, argument), argument, 0);
        index += 1;
        break;
      case '--query-rounds':
        options.queryRounds = count(value(index, argument), argument, 1);
        index += 1;
        break;
      case '--no-settle':
        options.settle = false;
        break;
      case '--store': {
        const store = value(index, argument);
        if (store !== 'postgres' && store !== 'in-memory') throw new Error('--store must be postgres or in-memory');
        options.store = store;
        index += 1;
        break;
      }
      case '--out':
        options.out = path.resolve(value(index, argument));
        index += 1;
        break;
      case '--checkouts':
        options.checkouts = path.resolve(value(index, argument));
        index += 1;
        break;
      case '--scip-timeout':
        options.scipTimeoutMs = count(value(index, argument), argument, 1);
        index += 1;
        break;
      case '--verify-only':
        options.verifyOnly = true;
        break;
      case '--keep-previous':
        options.keepPrevious = true;
        break;
      case '--migrate':
        options.migrate = true;
        break;
      case '--allow-shared-database':
        options.allowSharedDatabase = true;
        break;
      default:
        throw new Error(`unknown argument: ${String(argument)}`);
    }
  }
  return options;
}

// --- processes and git -------------------------------------------------------

async function git(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return run('git', args, { cwd: cwd ?? WORKSPACE });
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; binary?: boolean },
): Promise<{ code: number; stdout: string; stderr: string; raw: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const done = (code: number, extra = ''): void => {
      const raw = Buffer.concat(chunks);
      resolve({ code, stdout: raw.toString('utf8'), stderr: `${stderr}${extra}`, raw });
    };
    child.on('error', (error) => done(-1, error.message));
    child.on('close', (code) => done(code ?? -1));
  });
}

/** sha256 of the uncommitted changes: the diff against HEAD and every untracked file. */
async function treeFingerprint(): Promise<string | null> {
  const diff = await run('git', ['diff', 'HEAD', '--binary'], { cwd: WORKSPACE });
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (diff.code !== 0 || untracked.code !== 0) return null;
  const hash = createHash('sha256').update(diff.raw);
  for (const file of untracked.stdout.split('\0').filter(Boolean).sort()) {
    hash.update(`\0${file}\0`);
    try {
      const full = path.join(WORKSPACE, file);
      // A nested repository or a link to a directory is listed but is not a file.
      if ((await stat(full)).isFile()) hash.update(await readFile(full));
      else hash.update('<not a regular file>');
    } catch {
      hash.update('<unreadable>');
    }
  }
  return hash.digest('hex');
}

/**
 * Host, port and database a PostgreSQL URL connects to. `pg` lets query
 * parameters (`?host=`, `?port=`) override the authority, so they win here too.
 */
/**
 * `host:port/database` as pg will connect, or null for anything the guard
 * cannot vouch for: not a URL, a scheme other than postgres(ql):// (pg reads
 * socket: URLs' database from ?db=), or no database name (pg would take one
 * from PGDATABASE or the user name).
 */
function databaseTarget(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return null;
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (database === '') return null;
    const host = (parsed.searchParams.get('host') ?? parsed.hostname).toLowerCase();
    const port = parsed.searchParams.get('port') ?? (parsed.port || '5432');
    const local = ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(host) ? 'localhost' : host;
    return `${local}:${port}/${database}`;
  } catch {
    return null;
  }
}

/** DATABASE_URL as the shell has it and as the workspace .env has it. */
async function applicationDatabaseUrls(): Promise<string[]> {
  const urls: string[] = [];
  if (process.env.DATABASE_URL) urls.push(process.env.DATABASE_URL);
  try {
    for (const line of (await readFile(path.join(WORKSPACE, '.env'), 'utf8')).split('\n')) {
      const match = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1]) urls.push(match[1].replace(/^(['"])(.*)\1$/, '$2'));
    }
  } catch {
    // no .env
  }
  return urls;
}

/** Puts a checkout back to exactly its pinned commit, keeping node_modules; true when it is pristine. */
async function restoreCheckout(directory: string): Promise<boolean> {
  // scip-typescript writes a tsconfig.json into a project that has none
  // (--infer-tsconfig), so without this the second run would index a
  // different tree from the first.
  await git(['checkout', '--quiet', '--', '.'], directory);
  await git(['clean', '-fdq', '-e', 'node_modules'], directory);
  const status = await git(['status', '--porcelain', '--untracked-files=all'], directory);
  return status.code === 0 && status.stdout.split('\n').filter((line) => line && !/^\?\? .*node_modules\//.test(line)).length === 0;
}

/** The first directory at or above `start` that holds a node_modules, or null. */
function nodeModulesAbove(start: string): string | null {
  let directory = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(directory, 'node_modules'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Fetches exactly the pinned commit and checks that it is what came back. Never substitutes another. */
async function checkout(repo: ManifestRepository, root: string): Promise<{ directory: string; preexisting: boolean }> {
  const directory = path.join(root, `${repo.id}-${repo.commit.slice(0, 12)}`);

  if (existsSync(path.join(directory, '.git'))) {
    const head = await git(['rev-parse', 'HEAD'], directory);
    const clean = await git(['status', '--porcelain', '--ignored'], directory);
    // Reused only when it is exactly the pin and nothing was added to it.
    if (head.code === 0 && head.stdout.trim() === repo.commit && clean.code === 0 && clean.stdout.trim() === '') {
      return { directory, preexisting: true };
    }
    await rm(directory, { recursive: true, force: true });
  }

  await mkdir(directory, { recursive: true });
  const step = async (args: string[]): Promise<void> => {
    const result = await git(args, directory);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
  };

  await step(['init', '--quiet']);
  await step(['remote', 'add', 'origin', repo.url]);
  if (repo.sparsePaths) {
    // Cone mode: the listed directories plus every file at the root.
    await step(['sparse-checkout', 'set', '--cone', ...repo.sparsePaths]);
  }
  await step(['fetch', '--quiet', '--depth', '1', ...(repo.sparsePaths ? ['--filter=blob:none'] : []), 'origin', repo.commit]);
  await step(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);

  const head = await git(['rev-parse', 'HEAD'], directory);
  if (head.stdout.trim() !== repo.commit) {
    throw new Error(`checked out ${head.stdout.trim()} instead of the pinned ${repo.commit}`);
  }
  return { directory, preexisting: false };
}

/** Resolves the pin without checking anything out: the commit object only. */
async function verifyPin(repo: ManifestRepository): Promise<string | null> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ckg-pin-'));
  try {
    for (const args of [
      ['init', '--quiet', '--bare'],
      ['fetch', '--quiet', '--depth', '1', '--filter=tree:0', repo.url, repo.commit],
    ]) {
      const result = await git(args, directory);
      if (result.code !== 0) return `git ${args[0] ?? ''} failed: ${result.stderr.trim().split('\n').slice(-2).join(' ')}`;
    }
    const type = await git(['cat-file', '-t', repo.commit], directory);
    return type.stdout.trim() === 'commit' ? null : `${repo.commit} is not a commit in ${repo.url}`;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A dependency-prepared copy of a checkout: the pinned tarball, verified
 * against its sha512 integrity, extracted into node_modules/<package> of a
 * fresh copy. `tar` extracts files; nothing from the package runs.
 */
async function prepare(repo: ManifestRepository, source: string, root: string): Promise<{ directory: string; record: PreparationRecord }> {
  const prep = repo.preparation;
  if (!prep) throw new Error(`${repo.id} has no preparation`);
  const directory = path.join(root, `${repo.id}-${repo.commit.slice(0, 12)}--${prep.profile}`);
  await rm(directory, { recursive: true, force: true });
  await cp(source, directory, { recursive: true });

  const tarballDir = path.join(root, '.tarballs');
  await mkdir(tarballDir, { recursive: true });
  const tarball = path.join(tarballDir, `${prep.package.replace('/', '__')}-${prep.version}.tgz`);
  if (!existsSync(tarball)) {
    const response = await fetch(prep.tarball);
    if (!response.ok) throw new Error(`fetching ${prep.tarball} failed: HTTP ${String(response.status)}`);
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = await readFile(tarball);
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== prep.integrity) {
    await rm(tarball, { force: true });
    throw new Error(`${prep.package}@${prep.version} failed its integrity check (got ${actual})`);
  }

  // Only regular files and directories under package/, nothing absolute, no
  // '..': a link or a path escaping the target is refused before extraction.
  // Names from `tar -t`, types from the first character of `tar -tv` (the one
  // column BSD and GNU tar lay out the same way), in the same order.
  const names = await run('tar', ['-tzf', tarball], { cwd: directory });
  const verbose = await run('tar', ['-tzvf', tarball], { cwd: directory });
  if (names.code !== 0 || verbose.code !== 0) throw new Error(`listing ${prep.package} failed: ${names.stderr.trim()}${verbose.stderr.trim()}`);
  const entryNames = names.stdout.split('\n').filter(Boolean);
  const entryTypes = verbose.stdout.split('\n').filter(Boolean).map((line) => line.trimStart()[0]);
  if (entryNames.length !== entryTypes.length) throw new Error(`${prep.package} tarball listing is inconsistent`);
  entryNames.forEach((name, index) => {
    const type = entryTypes[index];
    if ((type !== '-' && type !== 'd') || !name.startsWith('package/') || name.split('/').includes('..')) {
      throw new Error(`${prep.package} tarball has an entry that is not a plain file under package/: ${name} (${String(type)})`);
    }
  });

  const target = path.join(directory, 'node_modules', ...prep.package.split('/'));
  await mkdir(target, { recursive: true });
  const untar = await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', target], { cwd: directory });
  if (untar.code !== 0) throw new Error(`extracting ${prep.package} failed: ${untar.stderr.trim()}`);

  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(path.join(directory, 'node_modules'));
  const tree = createHash('sha256');
  for (const file of files.sort()) {
    tree.update(`${path.relative(directory, file)}\0${createHash('sha256').update(await readFile(file)).digest('hex')}\n`);
  }

  return {
    directory,
    record: {
      repositoryId: repo.id,
      profile: prep.profile,
      package: prep.package,
      version: prep.version,
      tarball: prep.tarball,
      integrity: prep.integrity,
      integrityVerified: true,
      preparedTreeSha256: tree.digest('hex'),
      preparedFiles: files.length,
      scriptsRun: false,
    },
  };
}

async function repositoryFacts(repo: ManifestRepository, directory: string): Promise<RepositoryFacts> {
  const facts: RepositoryFacts = {
    id: repo.id,
    url: repo.url,
    commit: repo.commit,
    ref: repo.ref,
    tier: repo.tier,
    subdirectory: repo.subdirectory ?? null,
    trackedFiles: null,
    sourceFiles: null,
    sourceLines: null,
  };
  const listed = await git(['ls-files', '-z', '--', repo.subdirectory ?? '.'], directory);
  if (listed.code !== 0) return facts;

  const files = listed.stdout.split('\0').filter(Boolean);
  const sources = files.filter((file) => SOURCE_EXTENSIONS.test(file));
  let lines = 0;
  for (const file of sources) {
    try {
      const text = await readFile(path.join(directory, file), 'utf8');
      lines += text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch {
      // A tracked file outside the sparse checkout: not on disk, not indexed.
    }
  }
  return { ...facts, trackedFiles: files.length, sourceFiles: sources.length, sourceLines: lines };
}

// --- database ------------------------------------------------------------------

async function databaseSize(database: Database, projectId: string): Promise<DatabaseSize> {
  const [db, tables, project] = await Promise.all([
    database.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes'),
    database.query<{ name: string; bytes: string }>(
      `SELECT relname AS name, pg_total_relation_size(oid)::text AS bytes
         FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r'`,
      [GRAPH_TABLES],
    ),
    database.query<{ bytes: string | null }>(
      `SELECT ((SELECT coalesce(sum(pg_column_size(n.*)), 0) FROM code_nodes n WHERE n.project_id = $1)
             + (SELECT coalesce(sum(pg_column_size(e.*)), 0) FROM code_edges e WHERE e.project_id = $1))::text AS bytes`,
      [projectId],
    ),
  ]);
  return {
    databaseBytes: Number(db.rows[0]?.bytes ?? 0),
    tables: Object.fromEntries(tables.rows.map((row) => [row.name, Number(row.bytes)])),
    projectRowBytes: Number(project.rows[0]?.bytes ?? 0),
  };
}

async function databaseState(database: Database): Promise<DatabaseState> {
  const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);
  const [db, tables] = await Promise.all([
    database.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes'),
    database.query<{
      relation: string; live: string; dead: string; bytes: string;
      last_vacuum: Date | null; last_autovacuum: Date | null; last_analyze: Date | null; last_autoanalyze: Date | null;
    }>(
      `SELECT relname AS relation, n_live_tup::text AS live, n_dead_tup::text AS dead,
              pg_total_relation_size(relid)::text AS bytes,
              last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
         FROM pg_stat_user_tables WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [GRAPH_TABLES],
    ),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    databaseBytes: Number(db.rows[0]?.bytes ?? 0),
    tables: tables.rows.map((row) => ({
      relation: row.relation,
      liveTuples: Number(row.live),
      deadTuples: Number(row.dead),
      totalBytes: Number(row.bytes),
      lastVacuum: iso(row.last_vacuum),
      lastAutovacuum: iso(row.last_autovacuum),
      lastAnalyze: iso(row.last_analyze),
      lastAutoanalyze: iso(row.last_autoanalyze),
    })),
  };
}

/**
 * Deletes the given projects, then VACUUM (ANALYZE) of the graph tables: dead
 * rows reclaimed, planner statistics current.
 *
 * One session for all of it. Since PostgreSQL 15 a backend flushes its
 * statistics lazily (up to ~10 s later), so a DELETE on one pooled connection
 * could report its dead rows *after* a VACUUM on another had cleared them,
 * leaving `n_dead_tup` showing rows that are gone. Flushing explicitly
 * between the two keeps the recorded state true.
 */
async function deleteAndSettle(database: Database, projectIds: readonly string[], vacuum: boolean): Promise<SettleStep | null> {
  return database.withSession(async (session) => {
    for (const id of projectIds) await session.query('DELETE FROM projects WHERE id = $1', [id]);
    if (!vacuum) return null;
    await session.query('SELECT pg_stat_force_next_flush()');
    await session.query('SELECT 1');
    const started = performance.now();
    await session.query(`VACUUM (ANALYZE) ${GRAPH_TABLES.join(', ')}`);
    return { tables: [...GRAPH_TABLES], durationMs: Math.round((performance.now() - started) * 100) / 100 };
  });
}

async function settle(database: Database): Promise<SettleStep> {
  return (await deleteAndSettle(database, [], true)) as SettleStep;
}

async function projectHasGraph(database: Database, projectId: string): Promise<boolean> {
  const result = await database.query<{ present: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM code_nodes WHERE project_id = $1) AS present',
    [projectId],
  );
  return result.rows[0]?.present === true;
}

/**
 * The most connected classes, functions and methods. Ties are broken by
 * type, name and file — never by id, which is a hash of a project created
 * afresh on every invocation — so every invocation asks the same questions.
 */
async function queryTargets(database: Database, projectId: string, limit = 5): Promise<QueryTarget[]> {
  const result = await database.query<{ id: string; name: string; type: string; file_path: string | null }>(
    `SELECT n.id, coalesce(n.qualified_name, n.name) AS name, n.node_type AS type, n.file_path
       FROM code_nodes n
       JOIN code_edges e ON e.project_id = n.project_id AND (e.source_node_id = n.id OR e.target_node_id = n.id)
      WHERE n.project_id = $1 AND n.node_type IN ('class', 'function', 'method')
      GROUP BY n.id
      ORDER BY count(*) DESC, n.node_type, coalesce(n.qualified_name, n.name), n.file_path NULLS FIRST, n.id
      LIMIT $2`,
    [projectId, limit],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, type: row.type, filePath: row.file_path }));
}

// --- the API, for the query workload ----------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function startApi(databaseUrl: string): Promise<{ baseUrl: string; pid: number | null; startedAt: string; stop: () => Promise<void> }> {
  const entry = path.join(WORKSPACE, 'apps/api/dist/server.js');
  if (!existsSync(entry)) throw new Error('apps/api/dist/server.js is missing: run pnpm build:packages');
  const port = await freePort();
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [entry], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      NODE_ENV: 'production',
      LOCAL_FILESYSTEM_ENABLED: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the API exited during start-up: ${stderr.trim()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error('the API did not become healthy within 30s');
  }
  return {
    baseUrl,
    pid: child.pid ?? null,
    startedAt,
    stop: () =>
      new Promise((resolve) => {
        // Already gone (it crashed mid-workload): its 'close' has fired.
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
        child.once('close', () => {
          clearTimeout(force);
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}

// --- one run ----------------------------------------------------------------------

let runCounter = 0;

async function indexOnce(spec: Omit<IndexRunSpec, 'outFile'>, scratch: string, databaseUrl: string | null): Promise<{ output: IndexRunOutput | null; wallMs: number; error: string | null }> {
  runCounter += 1;
  const specFile = path.join(scratch, `spec-${String(runCounter)}.json`);
  const outFile = path.join(scratch, `out-${String(runCounter)}.json`);
  await writeFile(specFile, JSON.stringify({ ...spec, outFile }), 'utf8');

  const started = performance.now();
  const result = await run(TSX, [path.join(WORKSPACE, 'scripts/perf-index-once.ts'), specFile], {
    cwd: WORKSPACE,
    env: { ...process.env, ...(databaseUrl ? { BENCHMARK_DATABASE_URL: databaseUrl } : {}) },
  });
  const wallMs = Math.round((performance.now() - started) * 100) / 100;

  try {
    const output = JSON.parse(await readFile(outFile, 'utf8')) as IndexRunOutput;
    return { output, wallMs, error: null };
  } catch {
    const tail = result.stderr.trim().split('\n').slice(-5).join(' | ');
    return { output: null, wallMs, error: `the run process exited ${String(result.code)} without a result: ${tail}` };
  }
}

// --- main ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvFile();
  const options = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(options.manifest);
  const repos = selectRepositories(manifest, options.repos);
  const series = seriesOf(manifest);

  if (options.verifyOnly) {
    let failures = 0;
    for (const repo of repos) {
      const problem = await verifyPin(repo);
      if (problem) failures += 1;
      process.stdout.write(`${problem ? 'FAIL' : 'ok  '} ${repo.id.padEnd(18)} ${repo.commit}  ${problem ?? repo.ref}\n`);
    }
    if (failures > 0) process.exitCode = 1;
    return;
  }

  // --- preflight ----------------------------------------------------------------
  const problems: string[] = [];
  if (!existsSync('/usr/bin/time')) problems.push('/usr/bin/time is missing: the SCIP process cannot be measured');
  if (!existsSync(TSX)) problems.push('node_modules/.bin/tsx is missing: run pnpm install');
  if ((await execProbe('git', ['--version'])) === null) problems.push('git is not available');
  if (options.store === 'postgres' && options.queryIterations > 0 && !existsSync(path.join(WORKSPACE, 'apps/api/dist/server.js'))) {
    problems.push('apps/api/dist/server.js is missing: run pnpm build:packages (the query workload starts the built API)');
  }
  const leak = nodeModulesAbove(options.checkouts);
  if (leak) {
    problems.push(
      `the checkouts directory ${options.checkouts} has node_modules above it (${leak}); TypeScript would load its @types into every repository. Use --checkouts outside any Node project`,
    );
  }

  const scipCommand = process.env.SCIP_TYPESCRIPT_COMMAND || 'scip-typescript';
  let scipExecutable: string | null = null;
  try {
    scipExecutable = await resolveExecutable(scipCommand, { searchRoots: [WORKSPACE] });
  } catch (error) {
    problems.push(`scip-typescript not found: ${error instanceof Error ? error.message : String(error)}`);
  }

  let database: Database | null = null;
  let databaseInfo: DatabaseInfo | null = null;
  const databaseUrl = process.env.BENCHMARK_DATABASE_URL ?? null;
  if (options.store === 'postgres') {
    if (!databaseUrl) {
      problems.push('BENCHMARK_DATABASE_URL is not set (use a database dedicated to benchmarks, or --store in-memory)');
    } else if (
      !options.allowSharedDatabase &&
      (databaseTarget(databaseUrl)?.endsWith('/code_knowledge_graph') ||
        (await applicationDatabaseUrls()).some((url) => databaseTarget(url) !== null && databaseTarget(url) === databaseTarget(databaseUrl)))
    ) {
      problems.push('BENCHMARK_DATABASE_URL is the application database (same host, port and database as DATABASE_URL, or its default name); use a dedicated one or pass --allow-shared-database');
    } else if (databaseTarget(databaseUrl) === null) {
      problems.push('BENCHMARK_DATABASE_URL must be a postgres:// or postgresql:// URL that names its database');
    } else {
      database = createDatabase({ connectionString: databaseUrl, maxConnections: 4, applicationName: 'ckg-perf' });
      try {
        const status = await getMigrationStatus(database);
        if (status.drifted.length > 0) problems.push(`the benchmark database has drifted migrations (${status.drifted.join(', ')})`);
        if (status.pending.length > 0) {
          if (options.migrate) await migrate(database);
          else problems.push(`the benchmark database has pending migrations (${status.pending.join(', ')}); pass --migrate`);
        }
        const applied = await database.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations ORDER BY name');
        const meta = await database.query<{ name: string; version: string }>(
          'SELECT current_database() AS name, current_setting(\'server_version\') AS version',
        );
        databaseInfo = {
          name: meta.rows[0]?.name ?? 'unknown',
          serverVersion: meta.rows[0]?.version ?? null,
          migrations: applied.rows,
        };
      } catch (error) {
        problems.push(`cannot use the benchmark database: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`preflight: ${problem}\n`);
    await database?.close();
    process.exitCode = 1;
    return;
  }

  const environment = await captureEnvironment({
    workspaceRoot: WORKSPACE,
    scipExecutable,
    postgresVersion: databaseInfo?.serverVersion ?? null,
    treeFingerprint: await treeFingerprint(),
  });
  await mkdir(options.out, { recursive: true });
  await mkdir(options.checkouts, { recursive: true });
  const scratch = await mkdtemp(path.join(tmpdir(), 'ckg-perf-'));

  if (database && !options.keepPrevious) {
    // Only what earlier invocations of this harness created, then the space back.
    const previous = await database.query<{ id: string }>("SELECT id FROM projects WHERE name LIKE 'perf:%'");
    await deleteAndSettle(database, previous.rows.map((row) => row.id), options.settle);
  }

  const runs: RunRecord[] = [];
  const queries: QueryRecord[] = [];
  const workloads: QueryWorkloadRecord[] = [];
  const preparations: PreparationRecord[] = [];
  const repositoryStatus: PerfReport['repositories'] = [];
  const projects = database ? new ProjectRepository(database) : null;
  let fatalError: string | null = null;

  /** One repository, start to finish. Throws only on a harness or database failure. */
  const benchmarkRepository = async (repo: ManifestRepository): Promise<void> => {
    process.stdout.write(`\n== ${repo.id} @ ${repo.commit.slice(0, 12)} (${repo.ref})\n`);

    let checkedOut: { directory: string; preexisting: boolean };
    try {
      checkedOut = await checkout(repo, options.checkouts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`   checkout failed: ${message}\n`);
      repositoryStatus.push({ id: repo.id, status: 'checkout_failed', error: message });
      return;
    }

    let indexRoot = checkedOut.directory;
    let checkoutPreexisting = checkedOut.preexisting;
    if (repo.preparation) {
      try {
        const prepared = await prepare(repo, checkedOut.directory, options.checkouts);
        indexRoot = prepared.directory;
        checkoutPreexisting = false;
        preparations.push(prepared.record);
        process.stdout.write(`   prepared (${repo.preparation.profile}): ${String(prepared.record.preparedFiles)} files, integrity verified\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`   preparation failed: ${message}\n`);
        repositoryStatus.push({ id: repo.id, status: 'preparation_failed', error: message });
        return;
      }
    } else if (existsSync(path.join(indexRoot, 'node_modules'))) {
      repositoryStatus.push({ id: repo.id, status: 'checkout_failed', error: 'a dependency-free checkout must not contain node_modules' });
      return;
    }
    const status: PerfReport['repositories'][number] = { id: repo.id, status: 'ok', error: null };
    repositoryStatus.push(status);

    const facts = await repositoryFacts(repo, checkedOut.directory);
    const indexPath = path.join(indexRoot, repo.subdirectory ?? '');
    process.stdout.write(`   ${String(facts.sourceFiles)} source files, ${String(facts.sourceLines)} lines\n`);

    const newProject = async (): Promise<string | null> =>
      projects
        ? (
            await projects.create({
              name: `perf:${repo.id}@${repo.commit.slice(0, 12)}`,
              description: `Performance benchmark project for ${repo.url} at ${repo.commit}`,
            })
          ).id
        : null;

    const sampleCounts = { 'initial-index': 0, 're-index': 0 };
    let projectId: string | null = null;
    const totalRuns = options.initialRuns + options.reindexRuns;

    try {
      for (let index = 0; index < totalRuns; index += 1) {
        const phase = index < options.initialRuns ? 'initial' : 'reindex';
        let settleStep: SettleStep | null = null;

        if (phase === 'initial') {
          // A new project per initial-index sample; the previous sample's goes.
          if (database) settleStep = await deleteAndSettle(database, projectId ? [projectId] : [], options.settle);
          projectId = await newProject();
        }

        const checkoutPristine = await restoreCheckout(indexRoot);
        const graphBefore = database && projectId ? await projectHasGraph(database, projectId) : false;
        const kind = graphBefore ? 're-index' : 'initial-index';
        sampleCounts[kind] += 1;
        const databaseBefore = database ? await databaseState(database) : null;
        const startedAt = new Date().toISOString();

        const { output, wallMs, error } = await indexOnce(
          {
            repositoryPath: indexPath,
            projectId,
            store: options.store,
            workspaceDirectory: path.join(scratch, `workspace-${repo.id}-${String(index)}`),
            scipCommand,
            scipTimeoutMs: options.scipTimeoutMs,
            executableSearchRoots: [WORKSPACE],
          },
          scratch,
          databaseUrl,
        );

        const record: RunRecord = {
          repository: facts,
          run: {
            index,
            phase,
            kind,
            sample: sampleCounts[kind],
            startedAt,
            cacheState: {
              freshProcess: true,
              projectGraphPreexisting: graphBefore,
              freshWorkspace: true,
              checkoutPreexisting,
              checkoutPristine,
              databaseSettled: settleStep !== null,
              osPageCacheReset: false,
              databaseBufferCacheReset: false,
            },
          },
          outcome: output?.outcome ?? 'harness_error',
          error: output?.error ?? error,
          jobStatus: output?.jobStatus ?? null,
          persistence: output?.persistence ?? null,
          harnessWallMs: wallMs,
          stats: output?.stats ?? null,
          scip: output?.scip ?? null,
          databaseBefore,
          settle: settleStep,
          database: null,
        };
        if (database && projectId) {
          try {
            record.database = await databaseSize(database, projectId);
          } catch {
            record.database = null;
          }
        }
        runs.push(record);

        const completeness = record.stats?.completeness;
        process.stdout.write(
          `   ${kind.padEnd(13)} #${String(record.run.sample)} (${phase})  ${record.outcome.padEnd(9)} total ${String(record.stats?.timings?.totalMs ?? '-')} ms, persist ${String(record.stats?.timings?.phases.persist ?? '-')} ms, scip ${String(record.scip?.wallMs ?? '-')} ms` +
            `${completeness?.incomplete ? `, INCOMPLETE: ${completeness.reasons.join(',')}` : ''}${record.error ? `, error: ${record.error}` : ''}${checkoutPristine ? '' : ', CHECKOUT NOT PRISTINE'}\n`,
        );
      }

      if (database && databaseUrl && projectId && options.queryIterations > 0 && (await projectHasGraph(database, projectId))) {
        const settleStep = options.settle ? await settle(database) : null;
        const databaseBefore = await databaseState(database);
        const targets = await queryTargets(database, projectId);
        const plan = planQueries(projectId, targets);
        const rounds: QueryWorkloadRecord['rounds'] = [];
        const workload: QueryWorkloadRecord = {
          repositoryId: repo.id,
          projectId,
          targets: targets.map((target) => ({ type: target.type, name: target.name, filePath: target.filePath })),
          settle: settleStep,
          databaseBefore,
          databaseAfter: null,
          rounds,
        };
        workloads.push(workload);
        for (let round = 1; round <= options.queryRounds; round += 1) {
          const api = await startApi(databaseUrl);
          try {
            const records = await runQueries(plan, {
              baseUrl: api.baseUrl,
              repositoryId: repo.id,
              projectId,
              warmupPasses: options.queryWarmup,
              iterations: options.queryIterations,
              round,
            });
            queries.push(...records);
            rounds.push({ round, apiPid: api.pid, apiStartedAt: api.startedAt, warmupPasses: options.queryWarmup, measuredPasses: options.queryIterations });
            process.stdout.write(
              `   queries round ${String(round)}: ${String(plan.length)} distinct, ${String(options.queryWarmup)} warm-up + ${String(options.queryIterations)} measured passes, ${String(records.filter((r) => !r.ok).length)} failed\n`,
            );
          } finally {
            await api.stop();
          }
        }
        workload.databaseAfter = await databaseState(database);
      }
    } finally {
      // Back to the pin for the next invocation, and this repository's graph
      // out of the tables, so the next repository starts from a comparable
      // database rather than one holding every graph indexed before it.
      await restoreCheckout(indexRoot);
      if (database && projectId) await deleteAndSettle(database, [projectId], options.settle);
    }
  };

  try {
    for (const repo of repos) {
      try {
        await benchmarkRepository(repo);
      } catch (error) {
        // A harness or database failure in one repository: record it, keep
        // every run already measured, and go on to the next.
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`   ERROR: ${message}\n`);
        const existing = repositoryStatus.find((entry) => entry.id === repo.id);
        if (existing) {
          existing.status = 'error';
          existing.error = message;
        } else {
          repositoryStatus.push({ id: repo.id, status: 'error', error: message });
        }
      }
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
  } finally {
    await database?.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    for (const repo of repos) {
      if (!repositoryStatus.some((entry) => entry.id === repo.id)) {
        repositoryStatus.push({ id: repo.id, status: 'skipped', error: null });
      }
    }

    // Written whatever happened above: measured runs are never thrown away.
    const manifestBytes = await readFile(options.manifest);
    const report: PerfReport = {
      schema: PERF_REPORT_SCHEMA,
      generatedAt: new Date().toISOString(),
      environment,
      database: databaseInfo,
      configuration: {
        series,
        manifest: path.relative(WORKSPACE, options.manifest),
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        repositories: repos.map((repo) => repo.id),
        initialIndexRuns: options.initialRuns,
        reindexRuns: options.reindexRuns,
        queryWarmupPasses: options.queryWarmup,
        queryMeasuredPasses: options.queryIterations,
        queryRounds: options.queryRounds,
        settle: options.settle,
        store: options.store,
        scipTimeoutMs: options.scipTimeoutMs,
        scipCommand,
        checkoutsRoot: options.checkouts,
        keepPrevious: options.keepPrevious,
        migrate: options.migrate,
        sourceReadLimits: 'pipeline defaults',
        dependenciesInstalled: series === 'dependency-prepared',
        cacheReset: { osPageCache: false, databaseBufferCache: false },
      },
      fatalError,
      repositories: repositoryStatus,
      preparations,
      runs,
      queries,
      queryWorkloads: workloads,
      summary: { indexing: summarizeRuns(runs), queries: summarizeQueries(queries) },
    };

    await writeFile(path.join(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(path.join(options.out, 'runs.csv'), toCsv(runs, RUN_CSV_COLUMNS), 'utf8');
    await writeFile(path.join(options.out, 'queries.csv'), toCsv(queries, QUERY_CSV_COLUMNS), 'utf8');

    process.stdout.write('\nIndexing (completed runs; ms)\n');
    for (const entry of report.summary.indexing) {
      const total = entry.metrics.totalMs;
      const persist = entry.metrics['phase.persist'];
      process.stdout.write(
        `  ${entry.repositoryId.padEnd(18)} ${entry.kind.padEnd(13)} ${entry.phase.padEnd(7)} runs ${String(entry.runs)} ok ${String(entry.completed)} failed ${String(entry.failed)} incomplete ${String(entry.incomplete)}` +
          `  total median ${fmt(total?.median)} [${fmt(total?.min)}–${fmt(total?.max)}]  persist median ${fmt(persist?.median)}\n`,
      );
    }
    process.stdout.write(`\nResults: ${options.out}/{report.json,runs.csv,queries.csv}\n`);
    const sizeOfReport = (await stat(path.join(options.out, 'report.json'))).size;
    process.stdout.write(`report.json ${String(sizeOfReport)} bytes\n`);
    if (fatalError) process.exitCode = 1;
    else if (runs.some((record) => record.outcome !== 'completed') || repositoryStatus.some((entry) => entry.status !== 'ok')) {
      process.exitCode = 2;
    }
  }
}

function fmt(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : value.toFixed(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
