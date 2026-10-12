-- ---------------------------------------------------------------------------
-- 0006 edge endpoint indexes
--
-- Re-analysing a project replaces its graph: delete its edges, delete its
-- nodes, insert the new ones (`GraphRepository.replaceProjectGraph`). Deleting
-- a node fires the two `ON DELETE CASCADE` foreign keys from `code_edges`, and
-- each runs, once per deleted node,
--
--   DELETE FROM ONLY code_edges WHERE source_node_id = $1   -- and target_node_id
--
-- Every existing `code_edges` index leads with `project_id`, so neither lookup
-- had an index to seek into: each walked the whole `(project_id, …)` index.
-- Measured on a 9,395-node graph, the two triggers took 5.7 s of a 5.7 s node
-- delete — with the edges already gone, so finding nothing — and the cost grew
-- with every other project in the table, not with the one being replaced.
--
-- One index per endpoint, leading with it. Node ids are hashes of the project
-- scope, so the endpoint alone is as selective as the pair with `project_id`.
-- Nothing is dropped and no constraint or cascade changes: the existing
-- composite indexes still serve the graph queries that filter by project.
--
-- Built inside the migration's transaction, so not CONCURRENTLY: writes to
-- `code_edges` wait while each index builds. To undo by hand, drop both
-- indexes; the schema is otherwise as 0005 left it.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_code_edges_source_node_id
  ON code_edges (source_node_id);

CREATE INDEX IF NOT EXISTS idx_code_edges_target_node_id
  ON code_edges (target_node_id);
