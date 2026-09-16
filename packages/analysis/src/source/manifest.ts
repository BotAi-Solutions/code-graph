import type { SourceFileSet } from '@ckg/graph';

/**
 * The repository's `package.json`, as far as we trust it.
 *
 * Parsed defensively: a manifest is user input, and a malformed one must
 * degrade the analysis rather than fail it.
 */

export interface PackageManifest {
  relativePath: string;
  name: string | null;
  version: string | null;
  description: string | null;
  /** Runtime dependencies, name to declared range. */
  dependencies: Record<string, string>;
  /** Dev, peer and optional dependencies, kept apart from runtime ones. */
  developmentDependencies: Record<string, string>;
  scripts: Record<string, string>;
}

export function readManifest(sources: SourceFileSet): PackageManifest | null {
  const file = sources.byPath('package.json');
  if (!file || file.text.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  return {
    relativePath: 'package.json',
    name: stringOrNull(record.name),
    version: stringOrNull(record.version),
    description: stringOrNull(record.description),
    dependencies: stringRecord(record.dependencies),
    developmentDependencies: {
      ...stringRecord(record.devDependencies),
      ...stringRecord(record.peerDependencies),
      ...stringRecord(record.optionalDependencies),
    },
    scripts: stringRecord(record.scripts),
  };
}

/** Every declared dependency, runtime and development alike. */
export function declaredPackages(manifest: PackageManifest | null): Set<string> {
  if (!manifest) return new Set();
  return new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.developmentDependencies),
  ]);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}
