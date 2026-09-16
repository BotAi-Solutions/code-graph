import type {
  AnalysisJob,
  AnalysisProgress,
  AnalysisStats,
  AnalysisStatus,
  IndexingError,
  SupportedLanguage,
} from '@ckg/shared';
import { TERMINAL_ANALYSIS_STATUSES } from '@ckg/shared';
import type { Queryable } from '../client.js';
import { toAnalysisJob, type AnalysisJobRow } from './row-mappers.js';

export interface CreateAnalysisJobInput {
  projectId: string;
  repositoryId: string;
  language?: SupportedLanguage | null;
}

export interface UpdateAnalysisJobInput {
  status?: AnalysisStatus;
  language?: SupportedLanguage | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  error?: string | null;
  stats?: AnalysisStats | null;
  progress?: AnalysisProgress | null;
  errors?: IndexingError[] | null;
}

const COLUMNS =
  'id, project_id, repository_id, status, language, started_at, completed_at, error, stats, progress, errors, created_at, updated_at';

export class AnalysisJobRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateAnalysisJobInput): Promise<AnalysisJob> {
    const result = await this.db.query<AnalysisJobRow>(
      `INSERT INTO analysis_jobs (project_id, repository_id, status, language)
       VALUES ($1, $2, 'QUEUED', $3)
       RETURNING ${COLUMNS}`,
      [input.projectId, input.repositoryId, input.language ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('INSERT ... RETURNING produced no row');
    return toAnalysisJob(row);
  }

  async findById(id: string): Promise<AnalysisJob | null> {
    const result = await this.db.query<AnalysisJobRow>(
      `SELECT ${COLUMNS} FROM analysis_jobs WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toAnalysisJob(row) : null;
  }

  async listByProject(projectId: string, limit = 20): Promise<AnalysisJob[]> {
    const result = await this.db.query<AnalysisJobRow>(
      `SELECT ${COLUMNS} FROM analysis_jobs
       WHERE project_id = $1
       ORDER BY created_at DESC, id
       LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(toAnalysisJob);
  }

  /** The job currently occupying the pipeline for a project, if any. */
  async findActiveByProject(projectId: string): Promise<AnalysisJob | null> {
    const result = await this.db.query<AnalysisJobRow>(
      `SELECT ${COLUMNS} FROM analysis_jobs
       WHERE project_id = $1 AND status <> ALL($2::text[])
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId, TERMINAL_ANALYSIS_STATUSES],
    );
    const row = result.rows[0];
    return row ? toAnalysisJob(row) : null;
  }

  /**
   * Atomically takes the oldest queued job. `FOR UPDATE SKIP LOCKED` is what
   * makes it safe to run several worker processes against one database; the
   * queue abstraction in the worker can later be swapped for BullMQ without
   * touching this contract.
   */
  async claimNextQueued(): Promise<AnalysisJob | null> {
    const result = await this.db.query<AnalysisJobRow>(
      `UPDATE analysis_jobs
          SET status = 'INDEXING', started_at = now(), updated_at = now()
        WHERE id = (
          SELECT id FROM analysis_jobs
           WHERE status = 'QUEUED'
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
      RETURNING ${COLUMNS}`,
    );
    const row = result.rows[0];
    return row ? toAnalysisJob(row) : null;
  }

  async update(id: string, patch: UpdateAnalysisJobInput): Promise<AnalysisJob | null> {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];

    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (patch.status !== undefined) push('status', patch.status);
    if (patch.language !== undefined) push('language', patch.language);
    if (patch.startedAt !== undefined) push('started_at', patch.startedAt);
    if (patch.completedAt !== undefined) push('completed_at', patch.completedAt);
    if (patch.error !== undefined) push('error', patch.error);
    if (patch.stats !== undefined) push('stats', patch.stats === null ? null : JSON.stringify(patch.stats));
    if (patch.progress !== undefined) {
      push('progress', patch.progress === null ? null : JSON.stringify(patch.progress));
    }
    if (patch.errors !== undefined) {
      push('errors', patch.errors === null ? null : JSON.stringify(patch.errors));
    }

    params.push(id);

    const result = await this.db.query<AnalysisJobRow>(
      `UPDATE analysis_jobs SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${COLUMNS}`,
      params,
    );
    const row = result.rows[0];
    return row ? toAnalysisJob(row) : null;
  }

  /** Convenience used by the pipeline to advance through its phases. */
  async setStatus(id: string, status: AnalysisStatus): Promise<void> {
    await this.update(id, { status });
  }

  /**
   * Overwrites the progress record.
   *
   * Its own statement rather than a general `update` so the pipeline's hot path
   * — one write every few hundred milliseconds for the length of a run — writes
   * one column and returns nothing.
   */
  async setProgress(id: string, progress: AnalysisProgress): Promise<void> {
    await this.db.query(
      `UPDATE analysis_jobs SET progress = $1, updated_at = now() WHERE id = $2`,
      [JSON.stringify(progress), id],
    );
  }
}
