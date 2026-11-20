-- AI requests run as background jobs, and new items in progress are kept
-- as drafts on the server.
--
-- ai_jobs: one row per AI request, from the moment it is accepted until it
-- is dismissed or pruned (3 days after it finished, or when more than the
-- newest jobs are kept). request is the body the client sent, result the
-- response body the request produced, both gzip-compressed JSON like the
-- AI log's bodies; error is the error body, JSON. origin is an opaque
-- string the client gave: the screen to go back to for the result.
-- draft_id is the draft a job generates for. item_id and draft_id are not
-- foreign keys: a job outlives its item, as an AI log entry does, and is
-- left behind by a draft that is saved or discarded.
CREATE TABLE ai_jobs (
    id           TEXT    NOT NULL PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('draft', 'variant', 'testcases', 'code')),
    item_id      TEXT,
    draft_id     TEXT,
    title        TEXT    NOT NULL,
    status       TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    origin       TEXT,
    request      BLOB    NOT NULL,
    result       BLOB,
    error        TEXT,
    started_at   INTEGER,
    finished_at  INTEGER CHECK ((finished_at IS NULL) = (status IN ('queued', 'running'))),
    picked_up_at INTEGER
) WITHOUT ROWID;

CREATE INDEX ai_jobs_newest ON ai_jobs (created_at, id);
CREATE INDEX ai_jobs_status ON ai_jobs (status, created_at, id);

-- drafts: one row per new item in progress, until it is saved to the
-- library or discarded; drafts never expire. request is the body of the
-- latest generation, generation the result of the latest one that
-- succeeded, content the client's own document (its review form); all
-- three are gzip-compressed JSON. error is the latest generation's error,
-- JSON. generation_seq counts the generations that succeeded, based_on is
-- the one content was built from. title is the label lists show,
-- client_title the title the client set. variant_of and job_id are not
-- foreign keys: a draft outlives the item it is a variant of, and the jobs
-- that are pruned.
CREATE TABLE drafts (
    id             TEXT    NOT NULL PRIMARY KEY,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    kind           TEXT    NOT NULL CHECK (kind IN ('capture', 'variant')),
    variant_of     TEXT,
    title          TEXT    NOT NULL,
    client_title   TEXT,
    revision       INTEGER NOT NULL CHECK (revision >= 1),
    edited         INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
    request        BLOB,
    job_id         TEXT,
    error          TEXT,
    generation     BLOB,
    generation_seq INTEGER NOT NULL DEFAULT 0 CHECK (generation_seq >= 0),
    content        BLOB,
    based_on       INTEGER NOT NULL DEFAULT 0 CHECK (based_on >= 0 AND based_on <= generation_seq),
    CHECK ((kind = 'variant') = (variant_of IS NOT NULL))
) WITHOUT ROWID;

CREATE INDEX drafts_updated ON drafts (updated_at, id);
