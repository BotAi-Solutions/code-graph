import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Repository } from '@ckg/shared';
import { ERROR_CODES } from '@ckg/shared';
import { AppError } from '../../common/errors/index.js';

/**
 * Which directory a project's source lives in, and whether we may look at it.
 *
 * Extracted from `SourceService` when code search became a second reader of the
 * same files. The rules are the reason it is shared rather than copied: they
 * are the whole of what stops "read the file the graph pointed at" from being
 * "read any file on this machine", and two implementations of them would
 * eventually be two *different* implementations of them.
 *
 * Every caller gets the same three guarantees:
 *
 * 1. **The root comes from the project, never from the request.** Which disk a
 *    repository-relative path lands on is decided by the repository record
 *    attached to the project.
 * 2. **A git source is refused.** The worker shallow-clones it into scratch
 *    space and deletes it when the run finishes, so there is nothing left to
 *    read, and saying so is better than reading whatever happens to sit at that
 *    path now.
 * 3. **Nothing is readable at all when the local-filesystem switch is off**,
 *    which is what you set when the API is not on the user's own machine.
 */

export interface SourceRepositoryResolver {
  getForProject(projectId: string): Promise<Repository>;
}

export interface SourceRootOptions {
  enabled: boolean;
  /**
   * Base a relative repository `sourcePath` resolves against. The stored path
   * may be relative so the bundled samples keep working; which directory that
   * is relative *to* is a deployment fact, not a request one.
   */
  repositoryBaseDirectory: string;
}

export class SourceRoots {
  constructor(
    private readonly repositories: SourceRepositoryResolver,
    private readonly options: SourceRootOptions,
  ) {}

  /** Throws unless this server is allowed to read local files at all. */
  assertEnabled(): void {
    if (this.options.enabled) return;
    throw new AppError(
      ERROR_CODES.FILESYSTEM_ACCESS_DISABLED,
      'Local filesystem access is disabled on this server',
    );
  }

  /** The absolute, symlink-free directory this project's source was indexed from. */
  async resolve(projectId: string): Promise<string> {
    const repository = await this.repositories.getForProject(projectId);

    if (repository.sourceType !== 'local') {
      throw new AppError(
        ERROR_CODES.SOURCE_NOT_READABLE,
        'Source retrieval is only available for repositories indexed from a local path',
        { context: { projectId, sourceType: repository.sourceType } },
      );
    }

    const absolute = path.resolve(this.options.repositoryBaseDirectory, repository.sourcePath);

    try {
      return await realpath(absolute);
    } catch {
      throw new AppError(
        ERROR_CODES.REPOSITORY_PATH_NOT_FOUND,
        'The repository directory for this project is no longer readable',
        { context: { projectId } },
      );
    }
  }
}

/**
 * True when `candidate` is the root itself or sits beneath it.
 *
 * The separator matters: comparing raw prefixes would make `/srv/app-backup`
 * look like part of `/srv/app`.
 */
export function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}
