/**
 * The dashboard listing query.
 *
 * One statement, not one per project: a dashboard that issues N+1 queries feels
 * fine with three projects and falls over at fifty. Each `LATERAL` block is an
 * independent index-backed lookup, so cost grows with the page size rather than
 * with the size of the graph.
 *
 * Kept in its own file because it is long enough that inlining it would bury
 * the repository's other methods, and because two statements now share it: the
 * dashboard page and the by-id lookup path resolution needs. They differ only
 * in how rows are narrowed, so they are composed from one `SELECT` rather than
 * maintained as two copies that could drift.
 */
const PROJECT_SUMMARY_SELECT = `
SELECT
  p.id,
  p.name,
  p.description,
  p.created_at,
  p.updated_at,
  r.source_type,
  r.source_path,
  r.commit_hash,
  a.id            AS analysis_id,
  a.status        AS analysis_status,
  a.language      AS analysis_language,
  a.started_at    AS analysis_started_at,
  a.completed_at  AS analysis_completed_at,
  a.error         AS analysis_error,
  a.progress      AS analysis_progress,
  coalesce(g.node_count, 0) AS node_count,
  coalesce(g.edge_count, 0) AS edge_count,
  coalesce(t.node_type_counts, '{}'::jsonb) AS node_type_counts
FROM projects p

-- A project has at most one repository (unique index on project_id).
LEFT JOIN repositories r ON r.project_id = p.id

-- Most recent run, whatever its state: the dashboard shows failures too.
LEFT JOIN LATERAL (
  SELECT id, status, language, started_at, completed_at, error, progress
    FROM analysis_jobs
   WHERE project_id = p.id
   ORDER BY created_at DESC
   LIMIT 1
) a ON true

LEFT JOIN LATERAL (
  SELECT
    (SELECT count(*)::bigint FROM code_nodes WHERE project_id = p.id) AS node_count,
    (SELECT count(*)::bigint FROM code_edges WHERE project_id = p.id) AS edge_count
) g ON true

-- Composition of the graph, for the breakdown bar on each card.
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(node_type, count) AS node_type_counts
    FROM (
      SELECT node_type, count(*)::bigint AS count
        FROM code_nodes
       WHERE project_id = p.id
       GROUP BY node_type
    ) per_type
) t ON true
`;

/** The dashboard page: every project, newest first. `$1` limit, `$2` offset. */
export const PROJECT_SUMMARY_SQL = `
${PROJECT_SUMMARY_SELECT}
ORDER BY p.created_at DESC, p.id
LIMIT $1 OFFSET $2
`;

/**
 * The same rows for a known set of projects. `$1` is a uuid array.
 *
 * Path resolution needs summaries for the handful of projects whose repository
 * encloses a path, which is not a page of the listing and would otherwise be
 * one query per match. Ordered identically to the listing so that two callers
 * looking at the same projects see them in the same order.
 */
export const PROJECT_SUMMARY_BY_IDS_SQL = `
${PROJECT_SUMMARY_SELECT}
WHERE p.id = ANY($1::uuid[])
ORDER BY p.created_at DESC, p.id
`;
