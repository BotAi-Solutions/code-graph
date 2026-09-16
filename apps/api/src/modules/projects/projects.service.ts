import type { Project } from '@ckg/shared';
import type {
  CreateProjectInput,
  ListProjectSummariesResult,
  ListProjectsInput,
} from '@ckg/database';
import { AppError } from '../../common/errors/index.js';

/**
 * Data access this service needs. Declaring it structurally (rather than
 * importing the concrete class) is what lets tests pass an in-memory store and
 * keeps the service free of any database dependency.
 */
export interface ProjectStore {
  create(input: CreateProjectInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  listSummaries(input: ListProjectsInput): Promise<ListProjectSummariesResult>;
  delete(id: string): Promise<boolean>;
}

export class ProjectService {
  constructor(private readonly projects: ProjectStore) {}

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
}
