-- What each AI provider has been used for, rolled up per UTC day: one row
-- per provider and day with at least one request. provider_id is a plain
-- string, not a foreign key, because environment providers are not rows
-- of ai_providers; deleting a provider deletes its rows in the same
-- transaction. day counts days since 1970-01-01 (UTC); last_used_at is the
-- Unix time of the day's latest request. Only counts are kept, never
-- prompts or output.

CREATE TABLE ai_usage (
    provider_id   TEXT    NOT NULL,
    day           INTEGER NOT NULL,
    requests      INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
    failed        INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0 AND failed <= requests),
    input_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    last_used_at  INTEGER NOT NULL,
    PRIMARY KEY (provider_id, day)
) WITHOUT ROWID;


-- The AI activity log: one entry per request sent to a provider. It is
-- append-only: an entry is written once, when the request ends, and is
-- removed only when the user clears or prunes the log. The index row holds
-- what a list shows; the request and response live in ai_log_bodies,
-- gzip-compressed, and the system text, the same for most requests, once
-- per distinct text in ai_log_texts (keyed by its SHA-256). item_id is not
-- a foreign key: an entry outlives its item and its provider. Requests are
-- built from the server's own provider-neutral request, never from the
-- HTTP call, so they hold no key or header.
CREATE TABLE ai_log (
    id                 TEXT    NOT NULL PRIMARY KEY,
    created_at         INTEGER NOT NULL,
    operation          TEXT    NOT NULL,
    item_id            TEXT,
    title              TEXT,
    provider_id        TEXT    NOT NULL,
    provider_name      TEXT    NOT NULL,
    kind               TEXT    NOT NULL,
    model              TEXT    NOT NULL,
    status             TEXT    NOT NULL CHECK (status IN ('ok', 'failed', 'cancelled')),
    error              TEXT,
    duration_ms        INTEGER NOT NULL,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    reasoning_tokens   INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER
) WITHOUT ROWID;

CREATE INDEX ai_log_newest ON ai_log (created_at, id);
CREATE INDEX ai_log_provider ON ai_log (provider_id, created_at, id);
CREATE INDEX ai_log_operation ON ai_log (operation, created_at, id);
CREATE INDEX ai_log_status ON ai_log (status, created_at, id);

CREATE TABLE ai_log_texts (
    hash TEXT NOT NULL PRIMARY KEY,
    text BLOB NOT NULL
) WITHOUT ROWID;

CREATE TABLE ai_log_bodies (
    entry_id    TEXT    NOT NULL PRIMARY KEY REFERENCES ai_log (id) ON DELETE CASCADE,
    system_hash TEXT    REFERENCES ai_log_texts (hash),
    request     BLOB    NOT NULL,
    response    BLOB,
    truncated   INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))
) WITHOUT ROWID;

CREATE INDEX ai_log_bodies_system ON ai_log_bodies (system_hash);
