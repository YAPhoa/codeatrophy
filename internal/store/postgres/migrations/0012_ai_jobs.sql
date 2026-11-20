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
-- left behind by a draft that is saved or discarded. Free text is bytea,
-- as elsewhere.
CREATE TABLE ai_jobs (
    id           text   COLLATE "C" NOT NULL PRIMARY KEY,
    created_at   bigint NOT NULL,
    kind         text   COLLATE "C" NOT NULL CHECK (kind IN ('draft', 'variant', 'testcases', 'code')),
    item_id      text   COLLATE "C",
    draft_id     text   COLLATE "C",
    title        bytea  NOT NULL,
    status       text   COLLATE "C" NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    origin       bytea,
    request      bytea  NOT NULL,
    result       bytea,
    error        bytea,
    started_at   bigint,
    finished_at  bigint CHECK ((finished_at IS NULL) = (status IN ('queued', 'running'))),
    picked_up_at bigint
);

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
    id             text    COLLATE "C" NOT NULL PRIMARY KEY,
    created_at     bigint  NOT NULL,
    updated_at     bigint  NOT NULL,
    kind           text    COLLATE "C" NOT NULL CHECK (kind IN ('capture', 'variant')),
    variant_of     text    COLLATE "C",
    title          bytea   NOT NULL,
    client_title   bytea,
    revision       bigint  NOT NULL CHECK (revision >= 1),
    edited         boolean NOT NULL DEFAULT false,
    request        bytea,
    job_id         text    COLLATE "C",
    error          bytea,
    generation     bytea,
    generation_seq bigint  NOT NULL DEFAULT 0 CHECK (generation_seq >= 0),
    content        bytea,
    based_on       bigint  NOT NULL DEFAULT 0 CHECK (based_on >= 0 AND based_on <= generation_seq),
    CHECK ((kind = 'variant') = (variant_of IS NOT NULL))
);

CREATE INDEX drafts_updated ON drafts (updated_at, id);
