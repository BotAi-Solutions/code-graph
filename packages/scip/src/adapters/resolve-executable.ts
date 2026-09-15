import { access, constants } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolves a command name to an executable.
 *
 * A bare name such as `scip-typescript` is looked up in `node_modules/.bin`
 * walking up from each search root before falling back to `PATH`. That makes
 * the indexer work whether it was installed as a workspace dependency, run via
 * a pnpm script, or installed globally — without the caller caring which.
 */

export interface ResolveExecutableOptions {
  /** Directories to start the upward `node_modules/.bin` walk from. */
  searchRoots?: string[];
  maxLevels?: number;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): Promise<string> {
  // An explicit path is used verbatim; the caller has made the choice.
  if (command.includes('/') || command.includes('\\')) {
    return command;
  }

  const roots = options.searchRoots ?? [process.cwd()];
  const maxLevels = options.maxLevels ?? 8;

  for (const root of roots) {
    let directory = path.resolve(root);

    for (let level = 0; level < maxLevels; level += 1) {
      const candidate = path.join(directory, 'node_modules', '.bin', command);
      if (await isExecutable(candidate)) {
        return candidate;
      }

      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  // Not found locally: let the OS resolve it through PATH.
  return command;
}
