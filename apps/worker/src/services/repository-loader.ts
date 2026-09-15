import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Repository } from '@ckg/shared';
import { NodeCommandRunner, type CommandRunner } from '@ckg/scip';

/**
 * Resolves a stored repository record to a directory on disk that the indexer
 * can be pointed at.
 *
 * `local` sources are validated in place. `git` sources are shallow-cloned into
 * the analysis workspace, so nothing outside the workspace is ever written.
 */

export class RepositoryLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryLoadError';
  }
}

export interface LoadedRepository {
  /** Absolute path to the working tree to index. */
  path: string;
  /** Display name used for the repository node. */
  name: string;
  /** True when the directory was created for this analysis and is disposable. */
  ephemeral: boolean;
}

const CLONE_TIMEOUT_MS = 300_000;

export interface RepositoryLoaderOptions {
  /**
   * Base directory a relative `sourcePath` resolves against. Defaults to the
   * process working directory, which is right for a script run from the repo
   * root but not for a pnpm package script — the worker passes the monorepo
   * root explicitly.
   */
  baseDirectory?: string;
  commandRunner?: CommandRunner;
}

export class RepositoryLoader {
  private readonly baseDirectory: string;
  private readonly commandRunner: CommandRunner;

  constructor(options: RepositoryLoaderOptions = {}) {
    this.baseDirectory = options.baseDirectory ?? process.cwd();
    this.commandRunner = options.commandRunner ?? new NodeCommandRunner();
  }

  async load(repository: Repository, workspaceDirectory: string): Promise<LoadedRepository> {
    if (repository.sourceType === 'local') {
      return this.loadLocal(repository);
    }
    return this.cloneGit(repository, workspaceDirectory);
  }

  private async loadLocal(repository: Repository): Promise<LoadedRepository> {
    const absolute = path.resolve(this.baseDirectory, repository.sourcePath);

    let stats;
    try {
      stats = await stat(absolute);
    } catch {
      throw new RepositoryLoadError(
        `repository path does not exist: ${repository.sourcePath} (resolved to ${absolute})`,
      );
    }

    if (!stats.isDirectory()) {
      throw new RepositoryLoadError(`repository path is not a directory: ${repository.sourcePath}`);
    }

    return { path: absolute, name: path.basename(absolute), ephemeral: false };
  }

  private async cloneGit(
    repository: Repository,
    workspaceDirectory: string,
  ): Promise<LoadedRepository> {
    const target = path.join(workspaceDirectory, 'repository');
    const name = repositoryNameFromUrl(repository.sourcePath);

    const clone = await this.git(
      ['clone', '--depth', '1', '--quiet', repository.sourcePath, target],
      workspaceDirectory,
    );
    if (clone !== 0) {
      throw new RepositoryLoadError(`git clone failed for ${redactUrl(repository.sourcePath)}`);
    }

    if (repository.commitHash) {
      const fetched = await this.git(
        ['fetch', '--depth', '1', '--quiet', 'origin', repository.commitHash],
        target,
      );
      if (fetched !== 0) {
        throw new RepositoryLoadError(`commit ${repository.commitHash} could not be fetched`);
      }
      const checkedOut = await this.git(['checkout', '--quiet', 'FETCH_HEAD'], target);
      if (checkedOut !== 0) {
        throw new RepositoryLoadError(`commit ${repository.commitHash} could not be checked out`);
      }
    }

    return { path: target, name, ephemeral: true };
  }

  private async git(args: string[], cwd: string): Promise<number | null> {
    const result = await this.commandRunner.run('git', args, { cwd, timeoutMs: CLONE_TIMEOUT_MS });
    return result.exitCode;
  }
}

function repositoryNameFromUrl(url: string): string {
  const withoutSuffix = url.replace(/\.git$/, '');
  const segment = withoutSuffix.split(/[/:]/).filter(Boolean).pop();
  return segment ?? 'repository';
}

/** Git URLs can embed credentials; never let one reach a log or an error. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//[redacted]@');
}
