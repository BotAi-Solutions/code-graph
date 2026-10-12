import { readFile } from 'node:fs/promises';
import { IMPLEMENTED_LANGUAGES } from '@ckg/shared';

/**
 * The repositories the performance benchmark indexes, pinned to exact commits.
 *
 * Version-controlled at `benchmarks/repositories.json`. A pin is a full
 * 40-character commit SHA, never a branch or an abbreviated SHA: a branch
 * moves, and an abbreviation can become ambiguous as a repository grows. The
 * `ref` it came from (a release tag, a branch at a date) is recorded beside it
 * for a reader, and is never used to fetch.
 */

export const MANIFEST_SCHEMA = 1;

export const REPOSITORY_TIERS = ['S', 'M', 'L', 'XL'] as const;
export type RepositoryTier = (typeof REPOSITORY_TIERS)[number];

export interface ManifestRepository {
  /** Short, stable name used in file names and CLI arguments. */
  id: string;
  /** Clone URL. */
  url: string;
  /** Full commit SHA. */
  commit: string;
  /** Where the pin came from, for a reader: `v2.2.0`, `master on 2024-01-04`. */
  ref: string;
  /** Intended size class. The measured counts are recorded with every run. */
  tier: RepositoryTier;
  /** What this repository is in the set to exercise. */
  purpose: string;
  /** Languages the pipeline is expected to index here. */
  languages: string[];
  /**
   * Index this directory of the checkout rather than its root (immich's
   * `server/`). Relative, inside the checkout.
   */
  subdirectory?: string;
  /** Check out only these paths (a sparse checkout), for a large monorepo. */
  sparsePaths?: string[];
  /**
   * What has to happen before indexing. The benchmark measures the pipeline
   * as it runs in production, which installs nothing; `installDependencies`
   * is recorded so a result says which situation it describes.
   */
  setup: { installDependencies: boolean; notes?: string };
  /**
   * How a dependency-prepared series prepares this checkout. Absent in the
   * dependency-free series. Only one kind exists: extracting one package
   * tarball, pinned by exact version and sha512 integrity, into
   * `node_modules/<package>` of a copy outside the workspace. Nothing is
   * installed and no package script runs.
   */
  preparation?: TarballPreparation;
}

export interface TarballPreparation {
  profile: string;
  kind: 'tarball-extract';
  package: string;
  version: string;
  tarball: string;
  /** Subresource-integrity form, `sha512-<base64>`, as the npm registry publishes it. */
  integrity: string;
  scripts: 'never';
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  repositories: ManifestRepository[];
}

export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid benchmark manifest:\n  ${problems.join('\n  ')}`);
    this.name = 'ManifestError';
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Every problem with a manifest, not just the first. */
export function validateManifest(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) return ['the manifest must be an object'];

  const manifest = value as Record<string, unknown>;
  if (manifest.schema !== MANIFEST_SCHEMA) {
    problems.push(`schema must be ${String(MANIFEST_SCHEMA)} (got ${String(manifest.schema)})`);
  }
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0) {
    problems.push('repositories must be a non-empty array');
    return problems;
  }

  const seen = new Set<string>();
  manifest.repositories.forEach((entry: unknown, index) => {
    const where = `repositories[${String(index)}]`;
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${where} must be an object`);
      return;
    }
    const repo = entry as Record<string, unknown>;
    const name = typeof repo.id === 'string' ? repo.id : where;

    if (typeof repo.id !== 'string' || !ID.test(repo.id)) {
      problems.push(`${where}.id must be lower-case letters, digits and dashes`);
    } else if (seen.has(repo.id)) {
      problems.push(`${repo.id} is listed twice`);
    } else {
      seen.add(repo.id);
    }

    if (typeof repo.url !== 'string' || !/^(https:\/\/|git@|file:\/\/)/.test(repo.url)) {
      problems.push(`${name}.url must be an https, ssh or file URL`);
    }
    if (typeof repo.commit !== 'string' || !FULL_SHA.test(repo.commit)) {
      problems.push(`${name}.commit must be a full 40-character lower-case SHA (got ${String(repo.commit)})`);
    }
    for (const field of ['ref', 'purpose'] as const) {
      if (typeof repo[field] !== 'string' || (repo[field] as string).trim() === '') {
        problems.push(`${name}.${field} must be a non-empty string`);
      }
    }
    if (!REPOSITORY_TIERS.includes(repo.tier as RepositoryTier)) {
      problems.push(`${name}.tier must be one of ${REPOSITORY_TIERS.join(', ')}`);
    }
    if (
      !Array.isArray(repo.languages) ||
      repo.languages.length === 0 ||
      !repo.languages.every((language) => (IMPLEMENTED_LANGUAGES as readonly unknown[]).includes(language))
    ) {
      problems.push(
        `${name}.languages must list languages the pipeline indexes (${IMPLEMENTED_LANGUAGES.join(', ')})`,
      );
    }
    if (repo.subdirectory !== undefined && !isInsidePath(repo.subdirectory)) {
      problems.push(`${name}.subdirectory must be a relative path inside the checkout`);
    }
    if (
      repo.sparsePaths !== undefined &&
      (!Array.isArray(repo.sparsePaths) || repo.sparsePaths.length === 0 || !repo.sparsePaths.every(isInsidePath))
    ) {
      problems.push(`${name}.sparsePaths must be a non-empty list of relative paths`);
    }
    const setup = repo.setup as Record<string, unknown> | undefined;
    if (typeof setup !== 'object' || setup === null || typeof setup.installDependencies !== 'boolean') {
      problems.push(`${name}.setup.installDependencies must be a boolean`);
    }
    if (repo.preparation !== undefined) {
      const prep = repo.preparation as Record<string, unknown>;
      if (prep.kind !== 'tarball-extract') problems.push(`${name}.preparation.kind must be "tarball-extract"`);
      if (prep.scripts !== 'never') problems.push(`${name}.preparation.scripts must be "never"`);
      for (const field of ['profile', 'package', 'version'] as const) {
        if (typeof prep[field] !== 'string' || (prep[field] as string) === '') problems.push(`${name}.preparation.${field} must be a non-empty string`);
      }
      // Both become path segments: no traversal, no separators beyond a scope.
      if (typeof prep.profile === 'string' && !/^[a-z0-9][a-z0-9-]*$/.test(prep.profile)) {
        problems.push(`${name}.preparation.profile must be lower-case letters, digits and dashes`);
      }
      if (typeof prep.package === 'string' && !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(prep.package)) {
        problems.push(`${name}.preparation.package must be a valid npm package name`);
      }
      if (typeof prep.version === 'string' && !/^\d+\.\d+\.\d+$/.test(prep.version)) {
        problems.push(`${name}.preparation.version must be an exact version, not a range`);
      }
      if (typeof prep.tarball !== 'string' || !prep.tarball.startsWith('https://')) problems.push(`${name}.preparation.tarball must be an https URL`);
      if (typeof prep.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(prep.integrity)) {
        problems.push(`${name}.preparation.integrity must be a sha512 integrity string`);
      }
      if (setup && setup.installDependencies !== true) problems.push(`${name}: a prepared repository must set setup.installDependencies to true`);
    }
  });

  return problems;
}

/**
 * The series a manifest describes. A manifest is one series or the other:
 * mixing prepared and dependency-free repositories in one report would put
 * two different measurements under one heading.
 */
export function seriesOf(manifest: Manifest): 'dependency-free' | 'dependency-prepared' {
  const prepared = manifest.repositories.filter((repo) => repo.preparation !== undefined).length;
  if (prepared === 0) return 'dependency-free';
  if (prepared === manifest.repositories.length) return 'dependency-prepared';
  throw new ManifestError(['a manifest must be wholly dependency-free or wholly dependency-prepared']);
}

export function parseManifest(value: unknown): Manifest {
  const problems = validateManifest(value);
  if (problems.length > 0) throw new ManifestError(problems);
  return value as Manifest;
}

export async function loadManifest(file: string): Promise<Manifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new ManifestError([`${file}: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return parseManifest(parsed);
}

/** The repositories named, in manifest order; every unknown name is an error. */
export function selectRepositories(manifest: Manifest, ids: readonly string[] | null): ManifestRepository[] {
  if (ids === null || ids.length === 0) return manifest.repositories;
  const known = new Set(manifest.repositories.map((repo) => repo.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new ManifestError([`unknown repositories: ${unknown.join(', ')} (known: ${[...known].join(', ')})`]);
  }
  return manifest.repositories.filter((repo) => ids.includes(repo.id));
}

function isInsidePath(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.split('/').includes('..')
  );
}
