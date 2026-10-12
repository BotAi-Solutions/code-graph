import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { findWorkspaceRoot } from '@ckg/shared/node';
import { createDatabase, type Database } from '@ckg/database';

/**
 * The one way a test reaches PostgreSQL.
 *
 * Database-backed suites run against `TEST_DATABASE_URL` and nothing else.
 * There is no default connection string and `DATABASE_URL` is never read for
 * a connection: that variable names the development database, and the suites
 * migrate, write and delete. Unset, the suites skip; `pnpm test` needs no
 * database.
 *
 * A set variable is checked before anything connects, and a bad one fails the
 * suite loudly rather than skipping it:
 *
 * - the database name must contain `test`, and must not be the development
 *   database's default name, `code_knowledge_graph`;
 * - it must not point at the same host, port and database as `DATABASE_URL`,
 *   whether that is exported or only written in the workspace `.env` (read
 *   here without loading it into the environment);
 * - it must be reachable: an explicit database that cannot be reached is a
 *   broken setup, not a reason to skip.
 *
 * Only host, port and database name are ever printed.
 */

export const TEST_DATABASE_ENV = 'TEST_DATABASE_URL';
const DEVELOPMENT_DATABASE_NAME = 'code_knowledge_graph';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

export class UnsafeTestDatabaseError extends Error {}

interface Target {
  host: string;
  port: string;
  database: string;
}

export function targetOf(url: string): Target {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeTestDatabaseError(`${TEST_DATABASE_ENV} is not a valid URL`);
  }
  // pg reads other schemes differently: socket: takes the database from ?db=,
  // not the path, so the checks below would be looking at the wrong name.
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new UnsafeTestDatabaseError(`${TEST_DATABASE_ENV} must be a postgres:// or postgresql:// URL`);
  }
  // pg lets ?host= and ?port= override the authority; so does this check.
  const host = (parsed.searchParams.get('host') ?? parsed.hostname).toLowerCase();
  return {
    // localhost, 127.0.0.1 and ::1 are one server as far as this check cares.
    host: LOCAL_HOSTS.has(host) ? 'localhost' : host,
    port: parsed.searchParams.get('port') ?? (parsed.port || '5432'),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

export function describeTarget(url: string): string {
  const target = targetOf(url);
  return `${target.host}:${target.port}/${target.database}`;
}

/**
 * Why `url` must not be used as a test database, or null when it may. Pure:
 * the development URLs to compare with are passed in.
 */
export function unsafeReason(url: string, developmentUrls: readonly string[]): string | null {
  const target = targetOf(url);
  const name = target.database.toLowerCase();

  if (name === '') return `${TEST_DATABASE_ENV} names no database`;
  if (name === DEVELOPMENT_DATABASE_NAME) {
    return `${TEST_DATABASE_ENV} names the development database (${DEVELOPMENT_DATABASE_NAME})`;
  }
  if (!name.includes('test')) {
    return `${TEST_DATABASE_ENV} must name a database whose name contains "test" (got ${target.database})`;
  }
  for (const development of developmentUrls) {
    let other: Target;
    try {
      other = targetOf(development);
    } catch {
      continue;
    }
    if (other.host === target.host && other.port === target.port && other.database === target.database) {
      return `${TEST_DATABASE_ENV} points at the same database as DATABASE_URL (${describeTarget(url)})`;
    }
  }
  return null;
}

/** Every DATABASE_URL assignment in the text of a .env file, quotes removed. */
export function databaseUrlsInEnvFile(text: string): string[] {
  const urls: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1]) urls.push(match[1].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return urls;
}

/** DATABASE_URL from the shell and from the workspace .env, without loading the file. */
function developmentUrls(): string[] {
  const urls: string[] = [];
  if (process.env.DATABASE_URL) urls.push(process.env.DATABASE_URL);
  try {
    const file = path.join(findWorkspaceRoot(), '.env');
    if (existsSync(file)) urls.push(...databaseUrlsInEnvFile(readFileSync(file, 'utf8')));
  } catch {
    // No workspace root: nothing to compare with beyond the shell.
  }
  return urls;
}

/**
 * The test database URL for `suite`, or null (with a printed line) when none
 * is configured. Throws when the configured one is unsafe.
 */
export function testDatabaseUrl(suite: string): string | null {
  const url = process.env[TEST_DATABASE_ENV];
  if (!url) {
    process.stdout.write(`\n  ${suite}: skipped, ${TEST_DATABASE_ENV} is not set\n`);
    return null;
  }
  const reason = unsafeReason(url, developmentUrls());
  if (reason) throw new UnsafeTestDatabaseError(`${suite}: refusing to run. ${reason}.`);
  return url;
}

/**
 * A connection to the test database, or null when none is configured. An
 * explicit URL that cannot be reached throws.
 */
export async function connectTestDatabase(
  suite: string,
  options: { maxConnections?: number; applicationName?: string } = {},
): Promise<Database | null> {
  const url = testDatabaseUrl(suite);
  if (!url) return null;

  const database = createDatabase({
    connectionString: url,
    maxConnections: options.maxConnections ?? 2,
    applicationName: options.applicationName ?? 'ckg-integration-tests',
  });
  try {
    await database.query('SELECT 1');
  } catch (error) {
    await database.close().catch(() => undefined);
    throw new Error(
      `${suite}: ${TEST_DATABASE_ENV} is set but ${describeTarget(url)} cannot be reached (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  return database;
}
