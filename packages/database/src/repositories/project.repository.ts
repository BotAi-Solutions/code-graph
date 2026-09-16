import type {
  AnalysisProgress,
  AnalysisStatus,
  NodeTypeCounts,
  Project,
  ProjectSummary,
  RepositorySourceType,
  SupportedLanguage,
} from '@ckg/shared';
import type { Queryable } from '../client.js';
import { toProject, type ProjectRow } from './row-mappers.js';
import { PROJECT_SUMMARY_SQL } from './project-summary.sql.js';

export interface CreateProjectInput {
  name: string;
  description?: string | null;
}

export interface ListProjectsInput {
  limit: number;
  offset: number;
}

export interface ListProjectsResult {
  items: Project[];
  total: number;
}

export interface ListProjectSummariesResult {
  items: ProjectSummary[];
  total: number;
}

interface ProjectSummaryRow extends ProjectRow {
  source_type: string | null;
  source_path: string | null;
  commit_hash: string | null;
  analysis_id: string | null;
  analysis_status: string | null;
  analysis_language: string | null;
  analysis_started_at: Date | null;
  analysis_completed_at: Date | null;
  analysis_error: string | null;
  analysis_progress: AnalysisProgress | null;
  node_count: number;
  edge_count: number;
  node_type_counts: NodeTypeCounts;
}

function toProjectSummary(row: ProjectSummaryRow): ProjectSummary {
  return {
    ...toProject(row),
    repository:
      row.source_path === null
        ? null
        : {
            sourceType: row.source_type as RepositorySourceType,
            sourcePath: row.source_path,
            commitHash: row.commit_hash,
          },
    latestAnalysis:
      row.analysis_id === null
        ? null
        : {
            id: row.analysis_id,
            status: row.analysis_status as AnalysisStatus,
            language: (row.analysis_language as SupportedLanguage | null) ?? null,
            startedAt: row.analysis_started_at?.toISOString() ?? null,
            completedAt: row.analysis_completed_at?.toISOString() ?? null,
            error: row.analysis_error,
            progress: row.analysis_progress,
          },
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    nodeTypeCounts: row.node_type_counts ?? {},
  };
}

const COLUMNS = 'id, name, description, created_at, updated_at';

export class ProjectRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateProjectInput): Promise<Project> {
    const result = await this.db.query<ProjectRow>(
      `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING ${COLUMNS}`,
      [input.name, input.description ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('INSERT ... RETURNING produced no row');
    return toProject(row);
  }

  async findById(id: string): Promise<Project | null> {
    const result = await this.db.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM projects WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toProject(row) : null;
  }

  /**
   * Removes a project and everything that belonged to it.
   *
   * One statement: the repository, the analysis runs, the nodes and the edges
   * all reference the project with `ON DELETE CASCADE`, so the database does
   * the cascade in one transaction rather than this layer issuing five deletes
   * in an order it would have to get right.
   *
   * Returns false when there was no such project, so the caller can tell
   * "deleted" from "was not there" without a lookup first.
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM projects WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async list(input: ListProjectsInput): Promise<ListProjectsResult> {
    const [items, total] = await Promise.all([
      this.db.query<ProjectRow>(
        `SELECT ${COLUMNS} FROM projects ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`,
        [input.limit, input.offset],
      ),
      this.db.query<{ count: number }>('SELECT count(*)::bigint AS count FROM projects'),
    ]);

    return {
      items: items.rows.map(toProject),
      total: total.rows[0]?.count ?? 0,
    };
  }

  /**
   * The dashboard listing: every project with its source, its most recent run
   * and the size and shape of its graph, in one round trip.
   */
  async listSummaries(input: ListProjectsInput): Promise<ListProjectSummariesResult> {
    const [items, total] = await Promise.all([
      this.db.query<ProjectSummaryRow>(PROJECT_SUMMARY_SQL, [input.limit, input.offset]),
      this.db.query<{ count: number }>('SELECT count(*)::bigint AS count FROM projects'),
    ]);

    return {
      items: items.rows.map(toProjectSummary),
      total: total.rows[0]?.count ?? 0,
    };
  }

  async exists(id: string): Promise<boolean> {
    const result = await this.db.query('SELECT 1 FROM projects WHERE id = $1', [id]);
    return result.rowCount > 0;
  }
}
