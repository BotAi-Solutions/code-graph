import type { AnalysisJob, IndexFreshness, SourceRevision } from '@ckg/shared';
import { ERROR_CODES } from '@ckg/shared';
import { compareSourceRevision, type RevisionComparison } from '@ckg/language-detection';
import { isAppError } from '../../common/errors/index.js';
import type { ProjectService } from '../projects/projects.service.js';
import type { SourceRoots } from '../source/source-root.js';

/**
 * Does the stored graph still describe the files it was built from?
 *
 * The question an agent has to ask before trusting a graph in a repository it
 * is editing: `get_index_status` could already say "indexed", but indexed and
 * *current* are different claims, and the gap between them is exactly the
 * edits the agent just made.
 *
 * The comparison is against the latest **completed** run, because that is the
 * graph a query reads — a later run that failed or is still going has not
 * replaced it. The working tree is found through `SourceRoots`, the same policy
 * source retrieval and code search use, so this reads nothing they could not.
 *
 * "Current" means the files the indexer reads are, byte for byte, the files it
 * read — every one hashed at capture and again here — and HEAD has not moved.
 * An uncommitted edit, an untracked file or a deletion inside the indexing
 * scope is stale; a change under `node_modules` or `dist` is not. The check
 * reads and hashes files but parses nothing and writes nothing.
 *
 * Every way of not knowing is reported as `unknown` with its reason rather than
 * guessed at: a git-URL source has no working tree left to compare, a run from
 * before revisions were recorded has nothing to compare against, and a server
 * with local filesystem access switched off does not look.
 */

export interface FreshnessJobStore {
  listByProject(projectId: string, limit?: number): Promise<AnalysisJob[]>;
  findSourceRevision(id: string): Promise<SourceRevision | null>;
}

export type RevisionComparer = (
  directory: string,
  recorded: SourceRevision,
) => Promise<RevisionComparison>;

export interface FreshnessServiceOptions {
  /** Injected for tests; defaults to the real comparison against git and the filesystem. */
  compare?: RevisionComparer;
  now?: () => Date;
}

export class FreshnessService {
  private readonly compare: RevisionComparer;
  private readonly now: () => Date;

  constructor(
    private readonly jobs: FreshnessJobStore,
    private readonly projects: ProjectService,
    private readonly sourceRoots: SourceRoots,
    options: FreshnessServiceOptions = {},
  ) {
    this.compare = options.compare ?? ((directory, recorded) => compareSourceRevision(directory, recorded));
    this.now = options.now ?? (() => new Date());
  }

  async check(projectId: string): Promise<IndexFreshness> {
    await this.projects.getById(projectId);

    const runs = await this.jobs.listByProject(projectId);
    const completed = runs.find((run) => run.status === 'COMPLETED');
    const checkedAt = this.now().toISOString();

    if (!completed) {
      return {
        projectId,
        state: 'not_indexed',
        analysisId: null,
        vcs: null,
        indexedAt: null,
        indexedCommit: null,
        currentCommit: null,
        changedFiles: null,
        changedPaths: [],
        changes: null,
        reason: 'No indexing run has completed, so there is no graph to compare.',
        checkedAt,
      };
    }

    const revision = await this.jobs.findSourceRevision(completed.id);

    const base = {
      projectId,
      analysisId: completed.id,
      vcs: revision?.vcs ?? null,
      indexedAt: completed.completedAt,
      indexedCommit: revision?.commit ?? null,
      currentCommit: null,
      changedFiles: null,
      changedPaths: [],
      changes: null,
      checkedAt,
    };

    const unknown = (reason: string): IndexFreshness => ({ ...base, state: 'unknown', reason });

    if (!revision) {
      return unknown(
        'This graph was built before source revisions were recorded, so it cannot be compared with the files. Re-index to enable freshness checks.',
      );
    }

    let directory: string;
    try {
      this.sourceRoots.assertEnabled();
      directory = await this.sourceRoots.resolve(projectId);
    } catch (error) {
      if (!isAppError(error)) throw error;
      switch (error.code) {
        case ERROR_CODES.FILESYSTEM_ACCESS_DISABLED:
          return unknown('Local filesystem access is disabled on this server, so the files cannot be compared.');
        case ERROR_CODES.SOURCE_NOT_READABLE:
          return unknown('This project was indexed from a git URL; there is no local working tree to compare.');
        case ERROR_CODES.REPOSITORY_PATH_NOT_FOUND:
          return unknown('The repository directory this project was indexed from is no longer readable.');
        default:
          throw error;
      }
    }

    const comparison = await this.compare(directory, revision);

    return {
      ...base,
      state: comparison.stale === true ? 'stale' : comparison.stale === false ? 'current' : 'unknown',
      vcs: comparison.vcs,
      currentCommit: comparison.currentCommit,
      changedFiles: comparison.changedFiles,
      changedPaths: comparison.changedPaths,
      changes: comparison.changes,
      reason: comparison.reason,
    };
  }
}
