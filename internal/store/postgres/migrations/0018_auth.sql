-- Accounts that may sign in to the web UI, and their browser sessions.
-- email is stored in lower case. password_hash is a bcrypt hash. A
-- session's id is the SHA-256 hash (hex) of the token in the browser's
-- cookie; the token itself is never stored.

CREATE TABLE users (
    id            text   COLLATE "C" PRIMARY KEY,
    email         text   COLLATE "C" NOT NULL UNIQUE
                  CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
    password_hash text   COLLATE "C" NOT NULL,
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL
);

CREATE TABLE sessions (
    id         text   COLLATE "C" PRIMARY KEY,
    user_id    text   COLLATE "C" NOT NULL REFERENCES users (id) ON DELETE CASCADE DEFERRABLE,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);
