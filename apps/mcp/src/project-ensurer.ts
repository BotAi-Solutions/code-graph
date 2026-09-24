import {
  indexProjectResultSchema,
  type IndexProjectResult,
  type ProjectResolution,
} from '@ckg/shared';
import type { ApiClient } from './api-client.js';
import type { ProjectDirectoryHint } from './config.js';
import { resolveProjectRoot, type ResolvedProjectRoot } from './project-root.js';
import { readIndexStatus, type IndexStatus, type Readiness } from './tools/get-index-status.js';

/**
 * "Make sure the repository I am in is registered and indexed", as one step.
 *
 * Three things that are easy to conflate, and that this orchestrates without
 * owning any of them:
 *
 *   MCP registration      the client knows how to launch this server (user config)
 *   project registration  CodeRAG has a project for this directory (the API)
 *   graph indexing        a run has built that project's graph (the worker)
 *
 * Every step is an existing piece: the root comes from `project-root.ts`, the
 * project from `GET /api/projects/resolve` (what `resolve_project` calls), the
 * state from `readIndexStatus` (what `get_index_status` reports), and any
 * registration or run from `POST /api/projects/index` (what `index_project`
 * calls). This adds only the decision of whether that last call is needed:
 *
 *   indexing                  → nothing; report the active run
 *   ready, graph current      → nothing
 *   ready, freshness unknown  → nothing (see below)
 *   failed                    → nothing (see below)
 *   stale / never_indexed     → POST /api/projects/index
 *   no project at this root   → POST /api/projects/index (registers it)
 *
 * The two "nothing"s are deliberate. This runs on every server start, so a
 * state that indexing would not fix — a run that keeps failing, freshness that
 * can never be determined — must not queue a run every time a session opens.
 * `index_project` remains the explicit way to retry or force one.
 *
 * **No duplicates.** The API serialises index requests per directory and never
 * queues a second active run, which covers other processes. Within this
 * process, concurrent calls for one root share a single in-flight check — the
 * startup check and an early tool call, typically — so they do not even ask
 * twice.
 */

export type EnsureAction =
  /** No project existed at this directory; one was registered and its first run queued. */
  | 'registered'
  /** An existing project was stale or never indexed; a run was queued. */
  | 'started'
  /** A run was already queued or in progress; it is reported and no second one queued. */
  | 'already_indexing'
  /** The graph matches the files; nothing was queued. */
  | 'up_to_date'
  /** Indexing would not help or is not safe to repeat automatically; see `reason`. */
  | 'none';

export interface EnsureOutcome {
  projectId: string;
  projectName: string;
  /** The project's repository root — what every other tool's paths are relative to. */
  rootPath: string;
  /** The directory that was asked about. Differs from `rootPath` when it lies inside an enclosing project. */
  requestedPath: string;
  rootSource: ResolvedProjectRoot['source'];
  action: EnsureAction;
  /** The project's state after this call, in `get_index_status`'s vocabulary. */
  status: Readiness;
  /** The project is registered with CodeRAG. Always true for a returned outcome. */
  registered: true;
  /** This call created the project. */
  projectCreated: boolean;
  /** This call queued a run. */
  indexingStarted: boolean;
  indexed: boolean;
  indexing: boolean;
  indexingJobId: string | null;
  stale: boolean | null;
  indexedCommit: string | null;
  currentCommit: string | null;
  changedFiles: number | null;
  changedPaths: string[];
  error: string | null;
  reason: string;
}

/** The index route answered with something that is not its documented shape. */
export class UnexpectedResponseError extends Error {
  constructor(what: string) {
    super(`The graph API returned an unexpected response to ${what}.`);
    this.name = 'UnexpectedResponseError';
  }
}

export class ProjectEnsurer {
  private readonly inFlight = new Map<string, Promise<EnsureOutcome>>();

  constructor(
    private readonly api: ApiClient,
    private readonly hint: ProjectDirectoryHint | null,
  ) {}

  /** Whether the environment names a current project at all. */
  get hasCurrentProject(): boolean {
    return this.hint !== null;
  }

  /**
   * Ensures the project at `rootPath`, or at the environment's current project
   * when none is given. Throws `ProjectRootError` for a root that cannot be
   * used, and the API client's errors when the API cannot help.
   */
  async ensure(rootPath?: string): Promise<EnsureOutcome> {
    const root = await resolveProjectRoot({ explicit: rootPath, hint: this.hint });

    const existing = this.inFlight.get(root.rootPath);
    if (existing) return existing;

    const pending = this.ensureRoot(root).finally(() => {
      this.inFlight.delete(root.rootPath);
    });
    this.inFlight.set(root.rootPath, pending);
    return pending;
  }

  private async ensureRoot(root: ResolvedProjectRoot): Promise<EnsureOutcome> {
    const resolution = await this.api.get<ProjectResolution>('/api/projects/resolve', {
      path: root.rootPath,
    });

    // The project registered at exactly this directory, or else the narrowest
    // one containing it: a session opened in a package of an indexed monorepo
    // should use that graph, not register the package as a second project.
    const match = resolution.matches.find((candidate) => candidate.exact) ?? resolution.matches[0];

    if (!match) {
      return this.index(root, root.rootPath);
    }

    const status = await readIndexStatus(this.api, match.project.id);
    const identity = {
      projectId: match.project.id,
      projectName: match.project.name,
      rootPath: match.repositoryRoot,
    };

    switch (status.state) {
      case 'stale':
      case 'never_indexed':
        return this.index(root, match.repositoryRoot);

      case 'indexing':
        return outcome(root, identity, status, {
          action: 'already_indexing',
          projectCreated: false,
          indexingStarted: false,
          reason: `A run (${status.status ?? 'active'}) is already in progress; no second one was queued.`,
        });

      case 'ready':
        return outcome(root, identity, status, {
          action: status.freshness === 'current' ? 'up_to_date' : 'none',
          projectCreated: false,
          indexingStarted: false,
          reason:
            status.freshness === 'current'
              ? 'The graph matches the files on disk; nothing was queued.'
              : `The graph is indexed but its freshness is unknown (${status.freshnessReason ?? 'no reason given'}); it is not re-indexed automatically. Call index_project with force: true to re-index.`,
        });

      case 'failed':
        return outcome(root, identity, status, {
          action: 'none',
          projectCreated: false,
          indexingStarted: false,
          reason: `The last indexing run failed (${status.error ?? 'no reason recorded'}); it is not retried automatically. Fix the cause, then call index_project to retry.`,
        });
    }
  }

  /** The existing intake: register if new, queue unless active or current. */
  private async index(root: ResolvedProjectRoot, repositoryRoot: string): Promise<EnsureOutcome> {
    const raw = await this.api.post<unknown>('/api/projects/index', {
      path: repositoryRoot,
      force: false,
    });
    const parsed = indexProjectResultSchema.safeParse(raw);
    if (!parsed.success) throw new UnexpectedResponseError('the index request');

    const result = parsed.data;
    const status = await readIndexStatus(this.api, result.projectId);

    return outcome(
      root,
      { projectId: result.projectId, projectName: result.projectName, rootPath: result.repositoryRoot },
      status,
      {
        action: actionFor(result),
        projectCreated: result.projectCreated,
        indexingStarted: result.jobCreated,
        reason: result.reason,
      },
    );
  }
}

function actionFor(result: IndexProjectResult): EnsureAction {
  if (result.action === 'started') return result.projectCreated ? 'registered' : 'started';
  return result.action;
}

function outcome(
  root: ResolvedProjectRoot,
  identity: { projectId: string; projectName: string; rootPath: string },
  status: IndexStatus,
  decision: Pick<EnsureOutcome, 'action' | 'projectCreated' | 'indexingStarted' | 'reason'>,
): EnsureOutcome {
  return {
    ...identity,
    requestedPath: root.rootPath,
    rootSource: root.source,
    ...decision,
    status: status.state,
    registered: true,
    indexed: status.indexed,
    indexing: status.indexing,
    indexingJobId: status.indexingJobId,
    stale: status.stale,
    indexedCommit: status.indexedCommit,
    currentCommit: status.currentCommit,
    changedFiles: status.changedFiles,
    changedPaths: status.changedPaths,
    error: status.state === 'failed' ? status.error : null,
  };
}
