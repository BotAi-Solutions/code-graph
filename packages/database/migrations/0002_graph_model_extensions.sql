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
