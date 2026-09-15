import type { Repository, RepositorySourceType } from '@ckg/shared';
import type { UpsertRepositoryInput } from '@ckg/database';
import { AppError } from '../../common/errors/index.js';
import type { ProjectService } from '../projects/projects.service.js';

export interface RepositoryStore {
  upsert(input: UpsertRepositoryInput): Promise<Repository>;
  findByProjectId(projectId: string): Promise<Repository | null>;
}

export interface AttachRepositoryInput {
  projectId: string;
  sourceType: RepositorySourceType;
  sourcePath: string;
  commitHash?: string | null;
}

/**
 * A project has exactly one source repository; posting again replaces it. The
 * path is stored as given — validating that it exists is the worker's job,
 * because the API process may not share a filesystem with the worker.
 */
export class RepositoryService {
  constructor(
    private readonly repositories: RepositoryStore,
    private readonly projects: ProjectService,
  ) {}

  async attach(input: AttachRepositoryInput): Promise<Repository> {
    await this.projects.getById(input.projectId);

    return this.repositories.upsert({
      projectId: input.projectId,
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      commitHash: input.commitHash ?? null,
    });
  }

  async getForProject(projectId: string): Promise<Repository> {
    const repository = await this.repositories.findByProjectId(projectId);
    if (!repository) throw AppError.repositoryNotFound(projectId);
    return repository;
  }
}
