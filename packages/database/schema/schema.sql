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
-- ---------------------------------------------------------------------------
-- 0002 graph model extensions
--
-- The graph grew from SCIP-derived symbols to a code knowledge graph that also
-- carries architectural nodes (api, service, database, table, queue, event,
-- external_service, config) and the relationships between them. Three columns
-- and a handful of indexes are what the storage layer needs for that; the node
-- and edge tables themselves are unchanged in shape, so existing rows stay
-- valid and re-analysis replaces them as before.
--
-- Additive by construction: every column is nullable with no default, so this
-- migration neither rewrites nor locks out the existing graph. A node analysed
-- before this migration simply has no qualified name until its project is
-- analysed again, at which point its id is unchanged — ids are content hashes
-- of (project, repository, type, path, symbol), none of which these columns
-- touch.
-- ---------------------------------------------------------------------------

-- `qualified_name` is the dotted name a node is known by within its file:
-- `UserService.getUser` for a method, `POST /users` for a route,
-- `postgresql.users` for a table. It is what the analyzers resolve against and
-- what the search box matches, so it is indexed both raw and case-folded.
ALTER TABLE code_nodes ADD COLUMN IF NOT EXISTS qualified_name  TEXT;

-- Character offsets complete the range the graph already stored as lines, so a
-- caller can open an editor at the exact symbol rather than the line it starts
-- on. Zero-based, as every editor API expects.
ALTER TABLE code_nodes ADD COLUMN IF NOT EXISTS start_character INTEGER;
ALTER TABLE code_nodes ADD COLUMN IF NOT EXISTS end_character   INTEGER;

CREATE INDEX IF NOT EXISTS idx_code_nodes_qualified_name
  ON code_nodes (project_id, qualified_name);

-- Search folds case on all three of the columns it matches, and a functional
-- index is what keeps that from being a sequential scan.
CREATE INDEX IF NOT EXISTS idx_code_nodes_qualified_name_lower
  ON code_nodes (project_id, lower(qualified_name));
CREATE INDEX IF NOT EXISTS idx_code_nodes_file_path_lower
  ON code_nodes (project_id, lower(file_path));

-- The overview ranks nodes by degree and then filters by type; the traversal
-- expands by type. Both read (project_id, node_type, name) together.
CREATE INDEX IF NOT EXISTS idx_code_nodes_type_name
  ON code_nodes (project_id, node_type, name);

-- Node detail asks "everything touching this node" as one query over both
-- directions. These two cover each half without a sort.
CREATE INDEX IF NOT EXISTS idx_code_edges_source_rel_target
  ON code_edges (project_id, source_node_id, relationship, target_node_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_target_rel_source
  ON code_edges (project_id, target_node_id, relationship, source_node_id);
