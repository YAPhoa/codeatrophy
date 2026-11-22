-- Accounts that may sign in to the web UI, and their browser sessions.
-- email is stored in lower case. password_hash is a bcrypt hash. A
-- session's id is the SHA-256 hash (hex) of the token in the browser's
-- cookie; the token itself is never stored.

CREATE TABLE users (
    id            TEXT    PRIMARY KEY,
    email         TEXT    NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
    password_hash TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE sessions (
    id         TEXT    PRIMARY KEY,
    user_id    TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);
