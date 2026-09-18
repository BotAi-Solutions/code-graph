-- The users table, and the sessions that belong to one.
--
-- Written out in full so the schema is a fact the graph can read rather than
-- something inferred from the statements that happen to touch it.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY,
  email         TEXT        NOT NULL UNIQUE,
  display_name  TEXT,
  role          TEXT        NOT NULL,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users (id),
  token_hash  TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_sessions_user_id ON sessions (user_id);
