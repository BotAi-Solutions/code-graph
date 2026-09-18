import type { AnalysisContext } from '@ckg/graph';
import { readManifest } from '../source/manifest.js';
import { moduleSetFor } from '../source/shared.js';
import { parsePrismaSchema, type PrismaSchema } from './prisma.js';

/**
 * Which database this repository talks to, and what said so.
 *
 * Shared by the database analyzer and the SQL analyzer because the provider is
 * part of a table's identity: if the two disagreed about whether the provider
 * is `postgresql`, the table `users` declared in a migration and the table
 * `users` read by a repository class would be two different nodes.
 *
 * Four sources, in order of how directly they say it. Each is declarative; none
 * is a guess from a file name.
 */

/** Database drivers and ORMs, and the provider they imply. */
export const DRIVER_PROVIDERS: ReadonlyMap<string, string> = new Map([
  ['pg', 'postgresql'],
  ['postgres', 'postgresql'],
  ['pg-promise', 'postgresql'],
  ['@vercel/postgres', 'postgresql'],
  ['mysql', 'mysql'],
  ['mysql2', 'mysql'],
  ['sqlite3', 'sqlite'],
  ['better-sqlite3', 'sqlite'],
  ['@libsql/client', 'sqlite'],
  ['mssql', 'sqlserver'],
  ['oracledb', 'oracle'],
  ['mongodb', 'mongodb'],
  ['mongoose', 'mongodb'],
]);

const KNOWN_SCHEMES = new Set([
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'sqlite',
  'sqlserver',
  'mongodb',
]);

export interface DatabaseProvider {
  name: string;
  /** Where the provider was read from, for the record. */
  evidence: string;
}

export function normalizeProvider(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower === 'postgres') return 'postgresql';
  if (lower === 'mariadb') return 'mysql';
  return lower;
}

/** The Prisma schema, if the repository has one. */
export function prismaSchemaOf(context: AnalysisContext): PrismaSchema | null {
  const file = context.sources.matching('.prisma')[0];
  if (!file) return null;
  return parsePrismaSchema(file.relativePath, file.text);
}

export function detectDatabaseProvider(
  context: AnalysisContext,
  schema: PrismaSchema | null = prismaSchemaOf(context),
): DatabaseProvider | null {
  if (schema?.provider) {
    return { name: normalizeProvider(schema.provider), evidence: schema.relativePath };
  }

  const manifest = readManifest(context.sources);
  const declared = Object.keys(manifest?.dependencies ?? {});

  for (const [packageName, provider] of DRIVER_PROVIDERS) {
    if (declared.includes(packageName)) {
      return { name: provider, evidence: `package.json:${packageName}` };
    }
  }

  // Not declared but imported: an undeclared driver is still a driver.
  const modules = moduleSetFor(context.sources);
  for (const module of modules.modules()) {
    for (const packageName of module.bindings.packages()) {
      const provider = DRIVER_PROVIDERS.get(packageName);
      if (provider) return { name: provider, evidence: `${module.relativePath}:${packageName}` };
    }
  }

  // A connection string in an example environment file names the provider —
  // the scheme only; nothing else from these files is read.
  for (const file of context.sources.matching('.env.example', '.env.sample', '.env.template')) {
    const match = /\b([a-z][a-z0-9+.-]*):\/\//i.exec(file.text);
    const scheme = match?.[1]?.toLowerCase();
    if (scheme && KNOWN_SCHEMES.has(scheme)) {
      return { name: normalizeProvider(scheme), evidence: file.relativePath };
    }
  }

  return null;
}
