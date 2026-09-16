-- ---------------------------------------------------------------------------
-- 0003 indexing progress and per-file errors
--
-- A job already recorded which of six phases it was in. That is enough to say
-- "parsing" and nothing more — it cannot say "86 of 110 files", which is the
-- only thing that makes a progress bar worth showing on a repository that takes
-- minutes.
--
-- Two additive, nullable columns:
--
--   progress : the pipeline's own report of where it is — phase, current, total
--              and the counters it has accumulated. Overwritten in place as the
--              run proceeds; it is a position, not a history.
--   errors   : files that could not be read or parsed. A run completes in spite
--              of these, so they are not the `error` column, which means the
--              run itself failed.
--
-- Both are JSONB because their shape is owned by @ckg/shared and validated
-- there; promoting a field to a column would mean a migration every time the
-- pipeline learned to count something new, for no query we intend to run. Jobs
-- are read one at a time by primary key, so there is nothing to index.
-- ---------------------------------------------------------------------------

ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS progress JSONB;
ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS errors   JSONB;
