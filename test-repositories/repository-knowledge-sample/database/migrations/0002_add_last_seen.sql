-- One more column on an existing table, in its own migration.

ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ;
