import type { AnalysisJob, SupportedLanguage } from '@ckg/shared';
import { ERROR_CODES } from '@ckg/shared';
import type { CreateAnalysisJobInput } from '@ckg/database';
import { AppError } from '../../common/errors/index.js';
import type { ProjectService } from '../projects/projects.service.js';
import type { RepositoryService } from '../repositories/repositories.service.js';

export interface AnalysisJobStore {
  create(input: CreateAnalysisJobInput): Promise<AnalysisJob>;
  findById(id: string): Promise<AnalysisJob | null>;
  listByProject(projectId: string, limit?: number): Promise<AnalysisJob[]>;
  findActiveByProject(projectId: string): Promise<AnalysisJob | null>;
}

/**
 * Creating an analysis only enqueues it. The pipeline itself runs in the
 * worker, so an HTTP request never waits on SCIP — which can take minutes on a
 * large repository.
 */
export class AnalysisService {
  constructor(
    private readonly analysisJobs: AnalysisJobStore,
    private readonly projects: ProjectService,
    private readonly repositories: RepositoryService,
  ) {}

  async enqueue(input: {
    projectId: string;
    language?: SupportedLanguage | undefined;
  }): Promise<AnalysisJob> {
    await this.projects.getById(input.projectId);
    const repository = await this.repositories.getForProject(input.projectId);

    const active = await this.analysisJobs.findActiveByProject(input.projectId);
    if (active) {
      throw new AppError(
        ERROR_CODES.ANALYSIS_ALREADY_RUNNING,
        `Analysis ${active.id} is already running for this project`,
        { context: { analysisId: active.id, status: active.status } },
      );
    }

    return this.analysisJobs.create({
      projectId: input.projectId,
      repositoryId: repository.id,
      language: input.language ?? null,
    });
  }

  async getById(projectId: string, analysisId: string): Promise<AnalysisJob> {
    const job = await this.analysisJobs.findById(analysisId);
    // Scoped lookup: an analysis belonging to another project must read as
    // missing rather than leaking its existence.
    if (!job || job.projectId !== projectId) throw AppError.analysisNotFound(analysisId);
    return job;
  }

  async listForProject(projectId: string): Promise<AnalysisJob[]> {
    await this.projects.getById(projectId);
    return this.analysisJobs.listByProject(projectId);
  }
}
