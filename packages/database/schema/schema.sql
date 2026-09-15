-- ---------------------------------------------------------------------------
-- 0001 initial schema
--
-- projects      : a unit of analysis owned by a user
-- repositories  : the source location analysed for a project (1:1 today)
-- analysis_jobs : one run of the SCIP -> graph pipeline
-- code_nodes    : vertices of the code knowledge graph
-- code_edges    : relationships between vertices
--
-- Node and edge ids are *stable content hashes* produced by @ckg/graph, not
-- surrogate uuids: re-analysing an unchanged repository must yield identical
-- identities so the UI keeps its selection and downstream systems can cache.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects (created_at DESC);

CREATE TABLE IF NOT EXISTS repositories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  source_type  TEXT        NOT NULL CHECK (source_type IN ('local', 'git')),
  source_path  TEXT        NOT NULL,
  commit_hash  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One source repository per project. `POST /projects/:id/repository` is an
-- upsert against this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_repositories_project_id ON repositories (project_id);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  repository_id UUID        NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  status        TEXT        NOT NULL CHECK (status IN (
                  'QUEUED', 'INDEXING', 'PARSING', 'BUILDING_GRAPH',
                  'PERSISTING', 'COMPLETED', 'FAILED')),
  language      TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error         TEXT,
  stats         JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analysis_jobs_project_id ON analysis_jobs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status     ON analysis_jobs (status);
-- Supports the worker's "claim the oldest queued job" query.
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_queue      ON analysis_jobs (created_at) WHERE status = 'QUEUED';

CREATE TABLE IF NOT EXISTS code_nodes (
  id          TEXT PRIMARY KEY,
  project_id  UUID        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  node_type   TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  file_path   TEXT,
  start_line  INTEGER,
  end_line    INTEGER,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_nodes_project_id ON code_nodes (project_id);
CREATE INDEX IF NOT EXISTS idx_code_nodes_file_path  ON code_nodes (project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_code_nodes_node_type  ON code_nodes (project_id, node_type);
CREATE INDEX IF NOT EXISTS idx_code_nodes_name       ON code_nodes (project_id, name);
-- Case-insensitive prefix/substring search from the UI search box.
CREATE INDEX IF NOT EXISTS idx_code_nodes_name_lower ON code_nodes (project_id, lower(name));

CREATE TABLE IF NOT EXISTS code_edges (
  id             TEXT PRIMARY KEY,
  project_id     UUID        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  source_node_id TEXT        NOT NULL REFERENCES code_nodes (id) ON DELETE CASCADE,
  target_node_id TEXT        NOT NULL REFERENCES code_nodes (id) ON DELETE CASCADE,
  relationship   TEXT        NOT NULL,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_edges_project_id   ON code_edges (project_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_source       ON code_edges (project_id, source_node_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_target       ON code_edges (project_id, target_node_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_relationship ON code_edges (project_id, relationship);
-- Traversal filters on (direction, relationship) together.
CREATE INDEX IF NOT EXISTS idx_code_edges_source_rel   ON code_edges (project_id, source_node_id, relationship);
CREATE INDEX IF NOT EXISTS idx_code_edges_target_rel   ON code_edges (project_id, target_node_id, relationship);
