import type { Repository, RepositorySourceType } from '@ckg/shared';
import type { Queryable } from '../client.js';
import { toRepository, type RepositoryRow } from './row-mappers.js';

/**
 * Data access for the *source repository* attached to a project (the thing that
 * gets indexed), not to be confused with the repository pattern itself.
 */

export interface UpsertRepositoryInput {
  projectId: string;
  sourceType: RepositorySourceType;
  sourcePath: string;
  commitHash?: string | null;
}

const COLUMNS = 'id, project_id, source_type, source_path, commit_hash, created_at, updated_at';

export class SourceRepositoryRepository {
  constructor(private readonly db: Queryable) {}

  /** A project has at most one source repository; re-posting replaces it. */
  async upsert(input: UpsertRepositoryInput): Promise<Repository> {
    const result = await this.db.query<RepositoryRow>(
      `INSERT INTO repositories (project_id, source_type, source_path, commit_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id) DO UPDATE
         SET source_type = EXCLUDED.source_type,
             source_path = EXCLUDED.source_path,
             commit_hash = EXCLUDED.commit_hash,
             updated_at  = now()
       RETURNING ${COLUMNS}`,
      [input.projectId, input.sourceType, input.sourcePath, input.commitHash ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('INSERT ... RETURNING produced no row');
    return toRepository(row);
  }

  async findByProjectId(projectId: string): Promise<Repository | null> {
    const result = await this.db.query<RepositoryRow>(
      `SELECT ${COLUMNS} FROM repositories WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    return row ? toRepository(row) : null;
  }

  /**
   * Every registered repository.
   *
   * Unpaged on purpose. This exists for path resolution, which has to consider
   * all of them — the question "which indexed repository encloses this
   * directory" cannot be answered by a page — and the row count is bounded by
   * the number of projects an installation holds, one each. The caller applies
   * its own ceiling.
   *
   * Ordered so that repeated lookups rank identically: longest path first, so
   * the most specific repository is considered before the one that contains it,
   * then by id to break ties the path itself cannot.
   */
  async listAll(): Promise<Repository[]> {
    const result = await this.db.query<RepositoryRow>(
      `SELECT ${COLUMNS} FROM repositories ORDER BY length(source_path) DESC, id`,
    );
    return result.rows.map(toRepository);
  }

  async findById(id: string): Promise<Repository | null> {
    const result = await this.db.query<RepositoryRow>(
      `SELECT ${COLUMNS} FROM repositories WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toRepository(row) : null;
  }
}
