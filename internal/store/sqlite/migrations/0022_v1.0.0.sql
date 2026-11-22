-- The schema of Codeatrophy 1.0.0 (logical version 22), in one migration:
-- what migrations 0001 to 0022 built until that release, which a new
-- database gets at once. A database from before 1.0.0 is not migrated by
-- this one; it is upgraded with Codeatrophy 1.0.0 first.

-- Library items: problems and readings. seq is the insertion order and the
-- search index's rowid. variant_of names the item this one is a variant
-- of; it is not a foreign key, so that it outlives its origin (see
-- deleted_items). problem_interface says what the solver writes: 'program'
-- (a complete program) or 'function' (only the solution, which the hidden
-- per-language runner code in harness turns into a program). harness is a
-- JSON object keyed by language id, each entry {"prefix": ..., "suffix":
-- ...}. Both are NULL for readings.
--
-- created_* and updated_* record who created an item and who made its last
-- content change, for tracking only: via is the adapter that handled the
-- change ('http', 'mcp' or 'import'), client and model what the caller
-- reported (or the model of the server's own AI work). A record is all or
-- nothing: its via is NULL when it is unknown. created_* are written when
-- the item is inserted and never again.
CREATE TABLE items (
    seq                INTEGER PRIMARY KEY,
    id                 TEXT    NOT NULL UNIQUE,
    type               TEXT    NOT NULL,
    title              TEXT    NOT NULL,
    summary            TEXT    NOT NULL DEFAULT '',
    body               TEXT    NOT NULL DEFAULT '',
    difficulty         TEXT,
    raw_input          TEXT,
    source_url         TEXT,
    source_note        TEXT,
    variant_of         TEXT,
    revision           INTEGER NOT NULL DEFAULT 1,
    time_limit_ms      INTEGER,
    memory_limit_kb    INTEGER,
    compare_mode       TEXT,
    starter_code       TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    problem_interface  TEXT CHECK (problem_interface IN ('program', 'function')),
    harness            TEXT,
    created_via        TEXT,
    created_client     TEXT,
    created_model      TEXT,
    updated_via        TEXT,
    updated_client     TEXT,
    updated_model      TEXT
);

CREATE INDEX items_variant_of ON items (variant_of);
CREATE INDEX items_updated_at ON items (updated_at);
CREATE INDEX items_created_at ON items (created_at);

-- Tags are records of their own, so that a tag no item carries any more is
-- kept until it is deleted.
CREATE TABLE tags (
    name TEXT NOT NULL PRIMARY KEY
) WITHOUT ROWID;

CREATE TABLE item_tags (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    tag     TEXT NOT NULL REFERENCES tags (name),
    PRIMARY KEY (item_id, tag)
) WITHOUT ROWID;

CREATE INDEX item_tags_tag ON item_tags (tag);

-- A large test case keeps the generator that printed its input: a program
-- that reads nothing and prints the stdin. Both generator columns are NULL
-- for a case without one; stdin is stored either way, so nothing needs to
-- run the generator again.
CREATE TABLE test_cases (
    seq                INTEGER PRIMARY KEY,
    id                 TEXT    NOT NULL UNIQUE,
    item_id            TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    position           INTEGER NOT NULL,
    name               TEXT    NOT NULL DEFAULT '',
    stdin              TEXT    NOT NULL DEFAULT '',
    expected_stdout    TEXT    NOT NULL DEFAULT '',
    is_sample          INTEGER NOT NULL DEFAULT 0,
    origin             TEXT    NOT NULL,
    verified           INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    generator_language TEXT,
    generator_source   TEXT CHECK ((generator_source IS NULL) = (generator_language IS NULL))
);

CREATE INDEX test_cases_item ON test_cases (item_id, position);

-- Collections are personal: each account keeps its own tree of them, and
-- so its own memberships of items in them. The library of items is shared.
CREATE TABLE collections (
    seq         INTEGER PRIMARY KEY,
    id          TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    parent_id   TEXT REFERENCES collections (id) ON DELETE SET NULL,
    position    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    user_id     TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX collections_parent ON collections (parent_id, position);
CREATE INDEX collections_user_parent ON collections (user_id, parent_id, position);

CREATE TABLE collection_items (
    collection_id TEXT    NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    item_id       TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    PRIMARY KEY (collection_id, item_id)
) WITHOUT ROWID;

CREATE INDEX collection_items_item ON collection_items (item_id);

-- A submission keeps the runner it ran in (NULL for a program problem) and
-- how many lines that runner put before the submitted source.
CREATE TABLE submissions (
    seq            INTEGER PRIMARY KEY,
    id             TEXT    NOT NULL UNIQUE,
    item_id        TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    mode           TEXT    NOT NULL,
    language       TEXT    NOT NULL,
    source         TEXT    NOT NULL,
    stdin          TEXT,
    case_ids       TEXT    NOT NULL DEFAULT '[]',
    status         TEXT    NOT NULL,
    verdict        TEXT,
    passed_count   INTEGER NOT NULL DEFAULT 0,
    total_count    INTEGER NOT NULL DEFAULT 0,
    time_ms        INTEGER,
    memory_kb      INTEGER,
    compile_output TEXT    NOT NULL DEFAULT '',
    error          TEXT,
    created_at     INTEGER NOT NULL,
    finished_at    INTEGER,
    line_offset    INTEGER NOT NULL DEFAULT 0 CHECK (line_offset >= 0),
    harness        TEXT,
    user_id        TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX submissions_item ON submissions (item_id, seq);
CREATE INDEX submissions_status ON submissions (status);
CREATE INDEX submissions_user_item ON submissions (user_id, item_id, seq);

CREATE TABLE submission_results (
    submission_id   TEXT    NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    idx             INTEGER NOT NULL,
    test_case_id    TEXT,
    name            TEXT    NOT NULL DEFAULT '',
    is_sample       INTEGER NOT NULL DEFAULT 0,
    verdict         TEXT    NOT NULL,
    stdin           TEXT    NOT NULL DEFAULT '',
    expected_stdout TEXT,
    stdout          TEXT    NOT NULL DEFAULT '',
    stderr          TEXT    NOT NULL DEFAULT '',
    time_ms         INTEGER,
    memory_kb       INTEGER,
    PRIMARY KEY (submission_id, idx)
) WITHOUT ROWID;

-- Preferences are kept per account under "preferences:<user id>".
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

-- Full-text index over item content; rowid is items.seq. Maintained by the
-- store on every item write.
CREATE VIRTUAL TABLE items_fts USING fts5 (
    title,
    summary,
    body,
    tags,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Style presets: the user's named writing instructions. The application
-- enforces the full limits; these constraints back them up.
CREATE TABLE style_presets (
    seq          INTEGER PRIMARY KEY,
    id           TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    name_key     TEXT    NOT NULL UNIQUE,
    instructions TEXT    NOT NULL CHECK (length(instructions) BETWEEN 1 AND 2000),
    is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

-- At most one default preset.
CREATE UNIQUE INDEX style_presets_single_default ON style_presets (is_default) WHERE is_default = 1;

-- At most 20 presets.
CREATE TRIGGER style_presets_max_count BEFORE INSERT ON style_presets
WHEN (SELECT COUNT(*) FROM style_presets) >= 20
BEGIN
    SELECT RAISE(ABORT, 'too many style presets');
END;

-- Style preset names are a single line: no newline, tab or carriage return.
CREATE TRIGGER style_presets_name_single_line_insert BEFORE INSERT ON style_presets
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'style preset name must be a single line');
END;

CREATE TRIGGER style_presets_name_single_line_update BEFORE UPDATE OF name ON style_presets
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'style preset name must be a single line');
END;

-- Saved solutions. A problem keeps any number of them; at most one is the
-- reference solution. A solution keeps the figures of its last run on the
-- test cases: how many cases passed out of how many, the slowest case's
-- time and the peak memory (NULL when the judge measured nothing), and when
-- it ran. All are NULL for a solution that has not been run since its code
-- last changed.
CREATE TABLE solutions (
    seq                INTEGER PRIMARY KEY,
    id                 TEXT    NOT NULL UNIQUE,
    item_id            TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    name               TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    language           TEXT    NOT NULL,
    source             TEXT    NOT NULL CHECK (length(source) > 0),
    notes              TEXT    NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
    is_reference       INTEGER NOT NULL DEFAULT 0 CHECK (is_reference IN (0, 1)),
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    last_run_passed    INTEGER CHECK (last_run_passed >= 0),
    last_run_total     INTEGER CHECK (last_run_total >= 0),
    last_run_time_ms   INTEGER CHECK (last_run_time_ms >= 0),
    last_run_memory_kb INTEGER CHECK (last_run_memory_kb >= 0),
    last_run_at        INTEGER CHECK (
        CASE WHEN last_run_at IS NULL
            THEN last_run_passed IS NULL AND last_run_total IS NULL AND last_run_time_ms IS NULL AND last_run_memory_kb IS NULL
            ELSE last_run_passed IS NOT NULL AND last_run_total IS NOT NULL AND last_run_passed <= last_run_total
        END)
);

CREATE INDEX solutions_item ON solutions (item_id, seq);

-- At most one reference solution per item.
CREATE UNIQUE INDEX solutions_single_reference ON solutions (item_id) WHERE is_reference = 1;

-- Single-line names.
CREATE TRIGGER solutions_name_single_line_insert BEFORE INSERT ON solutions
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'solution name must be a single line');
END;

CREATE TRIGGER solutions_name_single_line_update BEFORE UPDATE OF name ON solutions
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'solution name must be a single line');
END;

-- At most 50 solutions per item.
CREATE TRIGGER solutions_max_per_item BEFORE INSERT ON solutions
WHEN (SELECT COUNT(*) FROM solutions WHERE item_id = NEW.item_id) >= 50
BEGIN
    SELECT RAISE(ABORT, 'too many solutions for this item');
END;

-- Saved AI providers: named connections to an AI service, each with its own
-- kind, model, base URL and API key. Empty model and base URL mean the
-- kind's default. api_key is ciphertext bound to (kind, api_key_origin); it
-- is empty when no key is stored. effort is low, medium or high, or NULL
-- for the model's own default, in which case none is sent.
CREATE TABLE ai_providers (
    seq            INTEGER PRIMARY KEY,
    id             TEXT    NOT NULL UNIQUE,
    name           TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    name_key       TEXT    NOT NULL UNIQUE,
    kind           TEXT    NOT NULL CHECK (kind IN ('anthropic', 'gemini', 'openai_compatible')),
    model          TEXT    NOT NULL DEFAULT '',
    base_url       TEXT    NOT NULL DEFAULT '',
    api_key        TEXT    NOT NULL DEFAULT '',
    api_key_origin TEXT    NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    effort         TEXT CHECK (effort IN ('low', 'medium', 'high'))
);

-- The kind is fixed at creation.
CREATE TRIGGER ai_providers_kind_immutable BEFORE UPDATE OF kind ON ai_providers
WHEN NEW.kind != OLD.kind
BEGIN
    SELECT RAISE(ABORT, 'the kind of an AI provider cannot be changed');
END;

-- Single-line names.
CREATE TRIGGER ai_providers_name_single_line_insert BEFORE INSERT ON ai_providers
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'AI provider name must be a single line');
END;

CREATE TRIGGER ai_providers_name_single_line_update BEFORE UPDATE OF name ON ai_providers
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'AI provider name must be a single line');
END;

-- At most 20 providers.
CREATE TRIGGER ai_providers_max_count BEFORE INSERT ON ai_providers
WHEN (SELECT COUNT(*) FROM ai_providers) >= 20
BEGIN
    SELECT RAISE(ABORT, 'too many AI providers');
END;

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
    cache_write_tokens INTEGER,
    user_id            TEXT    NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE INDEX ai_log_newest ON ai_log (created_at, id);
CREATE INDEX ai_log_provider ON ai_log (provider_id, created_at, id);
CREATE INDEX ai_log_operation ON ai_log (operation, created_at, id);
CREATE INDEX ai_log_status ON ai_log (status, created_at, id);
CREATE INDEX ai_log_user_newest ON ai_log (user_id, created_at, id);

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

-- AI requests run as background jobs: one row per AI request, from the
-- moment it is accepted until it is dismissed or pruned (3 days after it
-- finished, or when more than the newest jobs are kept). request is the
-- body the client sent, result the response body the request produced,
-- both gzip-compressed JSON like the AI log's bodies; error is the error
-- body, JSON. origin is an opaque string the client gave: the screen to go
-- back to for the result. draft_id is the draft a job generates for.
-- item_id and draft_id are not foreign keys: a job outlives its item, as an
-- AI log entry does, and is left behind by a draft that is saved or
-- discarded.
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
    picked_up_at INTEGER,
    user_id      TEXT    NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE INDEX ai_jobs_newest ON ai_jobs (created_at, id);
CREATE INDEX ai_jobs_status ON ai_jobs (status, created_at, id);
CREATE INDEX ai_jobs_user_newest ON ai_jobs (user_id, created_at, id);

-- New items in progress, kept on the server: one row per draft, until it is
-- saved to the library or discarded; drafts never expire. request is the
-- body of the latest generation, generation the result of the latest one
-- that succeeded, content the client's own document (its review form); all
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
    user_id        TEXT    NOT NULL DEFAULT '',
    CHECK ((kind = 'variant') = (variant_of IS NOT NULL))
) WITHOUT ROWID;

CREATE INDEX drafts_updated ON drafts (updated_at, id);
CREATE INDEX drafts_user_updated ON drafts (user_id, updated_at, id);

-- Links between items: one row per linked pair, the smaller id first.
-- Neither id refers to items: a link outlives its items.
CREATE TABLE item_links (
    seq        INTEGER PRIMARY KEY,
    item_a     TEXT    NOT NULL,
    item_b     TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (item_a, item_b),
    CHECK (item_a < item_b)
);

CREATE INDEX item_links_b ON item_links (item_b);

-- What is kept of a deleted item, so that what still names it (a link, a
-- variant's variant_of) can show it, until an item with its id is created
-- again.
CREATE TABLE deleted_items (
    id         TEXT    NOT NULL PRIMARY KEY,
    title      TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    deleted_at INTEGER NOT NULL
) WITHOUT ROWID;

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

-- What the account page shows of a session: the browser's User-Agent as it
-- was when the session started (at most 256 bytes; '' when unknown), and
-- when the session was last used. last_used_at moves only when the expiry
-- is pushed back, so it is accurate to about an hour.
CREATE TABLE sessions (
    id           TEXT    PRIMARY KEY,
    user_id      TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    user_agent   TEXT    NOT NULL DEFAULT '',
    last_used_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- Bearer tokens an account makes for its MCP clients. id is the SHA-256
-- hash (hex) of the token; the token itself is never stored. hint holds its
-- last characters, to tell tokens apart in a list.
CREATE TABLE mcp_tokens (
    id           TEXT    PRIMARY KEY,
    user_id      TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    hint         TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
) WITHOUT ROWID;

CREATE INDEX mcp_tokens_user_id ON mcp_tokens (user_id);

-- Personal data. An item's status, favorite and notes for an account, one
-- row per account and item that differs from the default (todo, not a
-- favorite, no notes). Working copies, submissions, drafts, AI jobs, the AI
-- log and collections record their account in user_id. The account ''
-- holds what is kept while no account exists; the first account created
-- takes it over.
CREATE TABLE item_states (
    user_id  TEXT    NOT NULL,
    item_id  TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    status   TEXT    NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    notes    TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, item_id)
) WITHOUT ROWID;

CREATE INDEX item_states_item_id ON item_states (item_id);

-- Working copies: the code an account is writing on a problem, one per
-- problem and language, kept so that it follows them across browsers. They
-- go with their item. write_seq orders them by when they were last written:
-- each write takes the next number, so the most recent write is the
-- highest, also within one second of updated_at.
CREATE TABLE working_copies (
    item_id    TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    language   TEXT    NOT NULL,
    source     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    write_seq  INTEGER NOT NULL,
    user_id    TEXT    NOT NULL,
    PRIMARY KEY (user_id, item_id, language)
) WITHOUT ROWID;

CREATE INDEX working_copies_write_seq ON working_copies (write_seq);
CREATE INDEX working_copies_item_id ON working_copies (item_id);

-- The built-in style presets a new instance starts with, each with a
-- random version-4 UUID. They are ordinary rows: fully editable and
-- deletable, and counted against the limit of 20. Like every migration this
-- runs once, so a deleted one never comes back. store.BuiltinStylePresets
-- holds the same text.
INSERT INTO style_presets (id, name, name_key, instructions, is_default, created_at, updated_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       name, lower(name), instructions, is_default,
       CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
FROM (
    SELECT 1 AS ord, 'Interview practice' AS name, 1 AS is_default,
        'Write the statement the way an interviewer would pose it: two or three short paragraphs in plain language, with no back-story. Name the inputs and say exactly what to return or print. Give two or three small examples, each followed by one or two sentences explaining why that output is correct. Keep the constraints to a short list, chosen so that the intended time complexity matters. Under Notes, add a "Follow-up" line that asks for a better complexity or a harder twist without giving the approach away, then one collapsed "Hint" that points toward the approach without naming it. For a reading: close with "Likely questions", three questions an interviewer might ask, each with its answer collapsed. Starter code in Python and Java.' AS instructions
    UNION ALL
    SELECT 2, 'Contest style', 0,
        'Write in the style of a programming-contest problem: a short, concrete scenario of at most one paragraph, then a precise formal statement. Use math notation for every bound, and put a formula the statement defines in a display equation. Choose the limits so that the intended complexity is implied but never named. Give at least two examples and explain only the non-obvious one, under Notes. When that example is a small graph or tree, draw it there as a small Mermaid diagram with plain labels. No hints. Starter code in C++ and Python.'
    UNION ALL
    SELECT 3, 'Study notes', 0,
        'Write for revision rather than for a test. For a reading: open with a two-sentence summary, then short sections with descriptive headings, each with a small worked example or code sample, and close with "Key takeaways" (three to five bullets) and "Check yourself" (three questions, each with its answer collapsed). Where the topic has a flow, a sequence or states, include one small Mermaid diagram. For a problem: keep the statement brief, and use Notes to point to related topics and, in a collapsed "Hint", name the underlying technique, without giving the solution. Prefer plain words to jargon, and define each term the first time it appears.'
)
ORDER BY ord;
