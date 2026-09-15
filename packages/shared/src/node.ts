import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Node-only helpers, on the `@ckg/shared/node` subpath so the browser bundle
 * never reaches them.
 */

const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'pnpm-lock.yaml'];
const MAX_LEVELS = 10;

/**
 * Locates the monorepo root.
 *
 * `process.cwd()` is not good enough: pnpm runs a package script with the
 * package directory as its cwd, so under `pnpm dev` the worker's cwd is
 * `apps/worker`. Anything that must mean the same thing however a process was
 * started — a relative repository path, the location of `.env` — resolves
 * against this instead.
 */
export function findWorkspaceRoot(startDirectory: string = moduleDirectory()): string {
  let directory = path.resolve(startDirectory);

  for (let level = 0; level < MAX_LEVELS; level += 1) {
    if (WORKSPACE_MARKERS.some((marker) => existsSync(path.join(directory, marker)))) {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  // Not inside a workspace (a standalone deployment, say): the process's own
  // working directory is the only sensible base left.
  return process.cwd();
}

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export interface LoadEnvFileOptions {
  /** Defaults to `.env` at the workspace root. */
  filePath?: string;
}

/**
 * Loads `.env` into `process.env` if it exists.
 *
 * Uses Node's built-in loader, so there is no dependency and the precedence is
 * the expected one: a variable already set in the real environment wins over
 * the file. Called once from each entry point, before configuration is read —
 * never from a config loader, which must stay a pure function of its input.
 *
 * Returns the file that was loaded, or null when there was none.
 */
export function loadEnvFile(options: LoadEnvFileOptions = {}): string | null {
  const filePath = options.filePath ?? path.join(findWorkspaceRoot(), '.env');
  if (!existsSync(filePath)) return null;

  process.loadEnvFile(filePath);
  return filePath;
}
