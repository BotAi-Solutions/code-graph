import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_RESOLUTION_MAX_CANDIDATES,
  PROJECT_RESOLUTION_MAX_MATCHES,
  type Project,
  type ProjectPathMatch,
  type ProjectResolution,
  type ProjectSummary,
  type Repository,
} from '@ckg/shared';
import type {
  CreateProjectInput,
  ListProjectSummariesResult,
  ListProjectsInput,
} from '@ckg/database';
import { AppError } from '../../common/errors/index.js';
import {
  containmentWithin,
  isFilesystemSource,
  resolveRequestedPath,
  type ResolvedPath,
} from './project-path.js';

/**
 * Data access this service needs. Declaring it structurally (rather than
 * importing the concrete class) is what lets tests pass an in-memory store and
 * keeps the service free of any database dependency.
 */
export interface ProjectStore {
  create(input: CreateProjectInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  listSummaries(input: ListProjectsInput): Promise<ListProjectSummariesResult>;
  findSummariesByIds(ids: readonly string[]): Promise<ProjectSummary[]>;
  delete(id: string): Promise<boolean>;
}

/**
 * The repositories, read as a catalogue rather than one at a time.
 *
 * Narrower than `RepositoryStore` in the repositories module on purpose: path
 * resolution only ever reads, and a service that cannot write repositories is
 * one that provably does not.
 */
export interface RepositoryCatalog {
  listAll(): Promise<Repository[]>;
}

export interface ProjectServiceOptions {
  /**
   * Base that a relative path resolves against — both a caller's relative
   * `path` and a stored relative `sourcePath`. The same value the worker and
   * source retrieval use, so all three agree on where the bundled samples live.
   */
  repositoryBaseDirectory: string;
  /**
   * Whether resolution may consult the filesystem to resolve symlinks.
   *
   * Off when `LOCAL_FILESYSTEM_ENABLED` is false, which is what you set when
   * the API is not on the caller's machine. Its filesystem is then a different
   * one from the caller's, so canonicalising against it would not clarify a
   * path — it would answer a question nobody asked. Matching falls back to
   * comparing the paths as written, which is the only thing that can mean
   * anything across two machines.
   */
  canonicalizePaths: boolean;
}

/** A repository that could enclose the requested path, with its root resolved. */
interface RepositoryCandidate {
  repository: Repository;
  root: ResolvedPath;
}

export class ProjectService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly repositories: RepositoryCatalog,
    private readonly options: ProjectServiceOptions,
  ) {}

  async create(input: { name: string; description?: string | null }): Promise<Project> {
    return this.projects.create({
      name: input.name,
      description: input.description ?? null,
    });
  }

  /**
   * The dashboard listing. Summaries rather than bare projects because the
   * listing always wants the graph size and the last run, and assembling that
   * server side is one query instead of one request per card.
   */
  async list(input: ListProjectsInput): Promise<ListProjectSummariesResult> {
    return this.projects.listSummaries(input);
  }

  async getById(projectId: string): Promise<Project> {
    const project = await this.projects.findById(projectId);
    if (!project) throw AppError.projectNotFound(projectId);
    return project;
  }

  /**
   * Which indexed projects cover a directory on disk.
   *
   * The inverse of the intake flow, and the question anything holding a working
   * directory rather than a project id has to ask before it can ask anything
   * else. Everywhere else in this API a project id is the way in; this is where
   * one comes from when all the caller has is a path.
   *
   * Three decisions shape the answer:
   *
   * **A list, not a project.** In a monorepo the repository root and a package
   * inside it may both have been indexed, and so may the same directory twice
   * under two projects. Every project that covers the path is returned, most
   * specific first, with the graph size and last run attached to each. Choosing
   * between them needs to know what the caller is for — whether a half-indexed
   * duplicate is better than none, whether the outer project or the inner one
   * is the subject — and this layer knows neither. It reports; it does not
   * guess.
   *
   * **No match is an answer.** A path no project covers returns an empty list
   * and a 200, the way a dismissed folder dialog does. "Nothing here is
   * indexed" is a fact a caller acts on — by indexing, or by reading files
   * directly — not a failure it should have to catch.
   *
   * **The path need not exist.** Nothing here stats the requested directory.
   * The API may be answering about a machine it cannot see, and a path that is
   * gone is still a path a stored repository record may name.
   */
  async resolveByPath(input: { path: string }): Promise<ProjectResolution> {
    const requested = await this.resolvePath(input.path);

    const repositories = await this.repositories.listAll();
    const candidates = await this.candidatesFor(repositories);

    const contained = candidates.flatMap((candidate) => {
      const containment = containmentWithin(candidate.root, requested);
      return containment ? [{ candidate, containment }] : [];
    });

    // Deepest root first before the cap applies, so a ceiling can only ever
    // drop the least specific matches — never the one the caller most likely
    // wants.
    contained.sort((a, b) => b.containment.root.length - a.containment.root.length);
    const kept = contained.slice(0, PROJECT_RESOLUTION_MAX_MATCHES);

    const summaries = await this.projects.findSummariesByIds(
      kept.map((entry) => entry.candidate.repository.projectId),
    );
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));

    const matches: ProjectPathMatch[] = kept.flatMap((entry) => {
      const project = byId.get(entry.candidate.repository.projectId);
      // Deleted between the two queries. Not an error: it is no longer a match.
      if (!project) return [];

      return [
        {
          project,
          repositoryRoot: entry.containment.root,
          relativePath: entry.containment.relativePath,
          exact: entry.containment.exact,
        },
      ];
    });

    matches.sort(compareMatches);

    return { path: requested.absolute, matches };
  }

  /**
   * Removes the project and its whole graph.
   *
   * Deliberately not blocked while an analysis is running. A worker that dies
   * mid-run leaves a job that never reaches a terminal state, and refusing to
   * delete until it does would strand exactly the project most likely to need
   * deleting. The run is orphaned instead: its job row goes with the project,
   * and the worker's next write finds nothing to write to.
   *
   * Nothing on disk is touched. The analysed repository is the user's own
   * working tree; this deletes what we derived from it, never the source.
   */
  async delete(projectId: string): Promise<void> {
    const deleted = await this.projects.delete(projectId);
    if (!deleted) throw AppError.projectNotFound(projectId);
  }

  /**
   * The repositories a path could plausibly be inside, with their roots
   * resolved once each.
   *
   * Git sources are dropped rather than compared: their `sourcePath` is a clone
   * URL, and the clone itself is deleted when a run finishes.
   *
   * The candidate ceiling is a guard against an installation with an
   * implausible number of projects, not a page — it is applied to the store's
   * own deterministic order (longest path first), so which candidates survive
   * it does not change between two identical requests.
   */
  private async candidatesFor(repositories: Repository[]): Promise<RepositoryCandidate[]> {
    const local = repositories
      .filter((repository) => isFilesystemSource(repository.sourceType))
      .slice(0, PROJECT_RESOLUTION_MAX_CANDIDATES);

    return Promise.all(
      local.map(async (repository) => ({
        repository,
        root: await this.resolvePath(
          path.resolve(this.options.repositoryBaseDirectory, repository.sourcePath),
        ),
      })),
    );
  }

  /**
   * A path as absolute, plus its symlink-free form when the filesystem can say.
   *
   * Canonicalisation is best-effort by design. A path that does not exist, or
   * one this process may not stat, still resolves lexically — the containment
   * rules then work from what was written, which is the answer a caller asking
   * about another machine's layout wants anyway.
   */
  private async resolvePath(requested: string): Promise<ResolvedPath> {
    const absolute = resolveRequestedPath(requested, this.options.repositoryBaseDirectory);

    if (!this.options.canonicalizePaths) return { absolute };

    try {
      return { absolute, canonical: await realpath(absolute) };
    } catch {
      return { absolute };
    }
  }
}

/**
 * Most specific first, then newest.
 *
 * Total and derived only from data the caller can see, so the same projects
 * always come back in the same order: a deeper repository root wins because it
 * is the more precise statement about the path; between two projects indexed
 * from the same root the newer one leads, matching the dashboard; and the id
 * settles what nothing else can.
 */
function compareMatches(a: ProjectPathMatch, b: ProjectPathMatch): number {
  if (a.repositoryRoot.length !== b.repositoryRoot.length) {
    return b.repositoryRoot.length - a.repositoryRoot.length;
  }
  if (a.project.createdAt !== b.project.createdAt) {
    return b.project.createdAt.localeCompare(a.project.createdAt);
  }
  return a.project.id.localeCompare(b.project.id);
}
