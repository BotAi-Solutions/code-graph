import path from 'node:path';
import type { AnalysisJob, IndexFreshness, IndexProjectResult } from '@ckg/shared';
import { ERROR_CODES } from '@ckg/shared';
import { AppError, isAppError } from '../../common/errors/index.js';
import { KeyedLock } from '../../common/utils/keyed-lock.js';
import type { AnalysisService } from '../analysis/analysis.service.js';
import type { FilesystemService } from '../filesystem/filesystem.service.js';
import type { ProjectService } from '../projects/projects.service.js';
import type { RepositoryService } from '../repositories/repositories.service.js';
import type { FreshnessService } from './freshness.service.js';

/**
 * "Make sure this directory is indexed", as one request.
 *
 * The web intake does this in three calls — create a project, attach a
 * repository, queue a run — because a person clicking through it has already
 * decided each step. An agent has not: it holds a directory and wants a graph,
 * and making it choose between creating and re-indexing, or race itself into a
 * second run, would be making it re-implement a policy that belongs here.
 *
 * So this composes the existing services and adds only the decisions:
 *
 *   validate the path  ─▶  find the project registered at exactly that root
 *                              │                          │
 *                         none: create it,          found: is a run active?
 *                         attach, queue                   │ yes ─▶ report that run
 *                                                         │ no  ─▶ graph current?
 *                                                         │        yes ─▶ nothing to do
 *                                                         └─────── no  ─▶ queue a run
 *
 * **No second pipeline.** The run is queued by `AnalysisService.enqueue`, the
 * call the UI makes, and executed by the worker like any other.
 *
 * **Never a duplicate project or run.** Requests for the same directory are
 * serialised, so two that arrive together cannot both find "nothing registered
 * here" and both create a project, or both find "no active run" and both queue
 * one — the second sees what the first did. An active run is returned rather
 * than joined by another, and `enqueue`'s own refusal still covers a run queued
 * by some other path (the UI) between the check and the queue.
 *
 * **Local paths only.** The path must be absolute and must be a readable
 * directory on this machine, validated by the same code as a folder chosen in
 * the UI. A git URL is not a path and is refused, and nothing here works at all
 * when local filesystem access is switched off.
 */

export interface ActiveJobLookup {
  findActiveByProject(projectId: string): Promise<AnalysisJob | null>;
}

export class IndexingService {
  private readonly perRoot = new KeyedLock();

  constructor(
    private readonly filesystem: FilesystemService,
    private readonly projects: ProjectService,
    private readonly repositories: RepositoryService,
    private readonly analysis: AnalysisService,
    private readonly freshness: FreshnessService,
    private readonly jobs: ActiveJobLookup,
  ) {}

  async index(input: { path: string; force?: boolean }): Promise<IndexProjectResult> {
    if (!path.isAbsolute(input.path)) {
      throw new AppError(
        ERROR_CODES.INVALID_PROJECT_PATH,
        'The project path must be an absolute path to a local directory. Git URLs are not accepted here.',
        { context: { path: input.path } },
      );
    }

    const root = await this.filesystem.resolveProjectDirectory(input.path);
    return this.perRoot.run(root, () => this.indexRoot(root, input.force ?? false));
  }

  private async indexRoot(root: string, force: boolean): Promise<IndexProjectResult> {
    const resolution = await this.projects.resolveByPath({ path: root });
    // Newest first among projects registered at the same root, matching the
    // order `resolve_project` reports them in.
    const existing = resolution.matches.find((match) => match.exact);

    if (!existing) return this.register(root);

    const projectId = existing.project.id;
    const identity = {
      projectCreated: false,
      projectId,
      projectName: existing.project.name,
      repositoryRoot: existing.repositoryRoot,
    };

    const active = await this.jobs.findActiveByProject(projectId);
    if (active) return this.alreadyIndexing(identity, active);

    let freshness: IndexFreshness | null = null;
    if (!force) {
      freshness = await this.checkFreshness(projectId);
      if (freshness?.state === 'current') {
        return {
          ...identity,
          action: 'up_to_date',
          jobCreated: false,
          job: null,
          freshness,
          reason: 'The stored graph already matches the files on disk; no run was queued. Pass force to re-index anyway.',
        };
      }
    }

    let job: AnalysisJob;
    try {
      job = await this.analysis.enqueue({ projectId });
    } catch (error) {
      if (isAppError(error) && error.code === ERROR_CODES.ANALYSIS_ALREADY_RUNNING) {
        const winner = await this.jobs.findActiveByProject(projectId);
        if (winner) return this.alreadyIndexing(identity, winner);
      }
      throw error;
    }

    return {
      ...identity,
      action: 'started',
      jobCreated: true,
      job,
      freshness,
      reason: force
        ? 'Re-index queued because it was forced.'
        : reasonToReindex(freshness),
    };
  }

  /**
   * A directory seen for the first time: the three intake steps, undone if the
   * second or third fails, so a failed request does not leave a project with
   * no repository or no run behind it for the next request to trip over.
   */
  private async register(root: string): Promise<IndexProjectResult> {
    const project = await this.projects.create({ name: path.basename(root) || root });

    let job: AnalysisJob;
    try {
      await this.repositories.attach({ projectId: project.id, sourceType: 'local', sourcePath: root });
      job = await this.analysis.enqueue({ projectId: project.id });
    } catch (error) {
      await this.projects.delete(project.id).catch(() => undefined);
      throw error;
    }

    return {
      action: 'started',
      projectCreated: true,
      jobCreated: true,
      projectId: project.id,
      projectName: project.name,
      repositoryRoot: root,
      job,
      freshness: null,
      reason: 'No project was registered at this directory; one was created and its first run queued.',
    };
  }

  private alreadyIndexing(
    identity: Pick<IndexProjectResult, 'projectCreated' | 'projectId' | 'projectName' | 'repositoryRoot'>,
    job: AnalysisJob,
  ): IndexProjectResult {
    return {
      ...identity,
      action: 'already_indexing',
      jobCreated: false,
      job,
      freshness: null,
      reason: `A run (${job.status}) is already in progress for this project; no second one was queued.`,
    };
  }

  /**
   * Freshness is advice here, not a gate. If it cannot be checked the safe
   * default is to index — a redundant run costs time, a skipped one costs a
   * wrong answer.
   */
  private async checkFreshness(projectId: string): Promise<IndexFreshness | null> {
    try {
      return await this.freshness.check(projectId);
    } catch {
      return null;
    }
  }
}

function reasonToReindex(freshness: IndexFreshness | null): string {
  if (!freshness) return 'Re-index queued; freshness could not be checked.';
  switch (freshness.state) {
    case 'not_indexed':
      return 'No completed graph exists for this project; a run was queued.';
    case 'stale':
      return `Re-index queued because the graph is stale: ${freshness.reason}`;
    default:
      return `Re-index queued because freshness is unknown: ${freshness.reason}`;
  }
}
