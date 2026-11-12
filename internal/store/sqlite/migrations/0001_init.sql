-- Initial schema.

CREATE TABLE items (
    seq                INTEGER PRIMARY KEY,
    id                 TEXT    NOT NULL UNIQUE,
    type               TEXT    NOT NULL,
    title              TEXT    NOT NULL,
    summary            TEXT    NOT NULL DEFAULT '',
    body               TEXT    NOT NULL DEFAULT '',
    difficulty         TEXT,
    status             TEXT    NOT NULL,
    favorite           INTEGER NOT NULL DEFAULT 0,
    notes              TEXT    NOT NULL DEFAULT '',
    raw_input          TEXT,
    source_url         TEXT,
    source_note        TEXT,
    variant_of         TEXT REFERENCES items (id) ON DELETE SET NULL,
    revision           INTEGER NOT NULL DEFAULT 1,
    time_limit_ms      INTEGER,
    memory_limit_kb    INTEGER,
    compare_mode       TEXT,
    starter_code       TEXT,
    reference_language TEXT,
    reference_source   TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);

CREATE INDEX items_variant_of ON items (variant_of);
CREATE INDEX items_updated_at ON items (updated_at);
CREATE INDEX items_created_at ON items (created_at);

CREATE TABLE item_tags (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (item_id, tag)
) WITHOUT ROWID;

CREATE INDEX item_tags_tag ON item_tags (tag);

CREATE TABLE test_cases (
    seq             INTEGER PRIMARY KEY,
    id              TEXT    NOT NULL UNIQUE,
    item_id         TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    name            TEXT    NOT NULL DEFAULT '',
    stdin           TEXT    NOT NULL DEFAULT '',
    expected_stdout TEXT    NOT NULL DEFAULT '',
    is_sample       INTEGER NOT NULL DEFAULT 0,
    origin          TEXT    NOT NULL,
    verified        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX test_cases_item ON test_cases (item_id, position);

CREATE TABLE collections (
    seq         INTEGER PRIMARY KEY,
    id          TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    parent_id   TEXT REFERENCES collections (id) ON DELETE SET NULL,
    position    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX collections_parent ON collections (parent_id, position);

CREATE TABLE collection_items (
    collection_id TEXT    NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    item_id       TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    PRIMARY KEY (collection_id, item_id)
) WITHOUT ROWID;

CREATE INDEX collection_items_item ON collection_items (item_id);

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
    finished_at    INTEGER
);

CREATE INDEX submissions_item ON submissions (item_id, seq);
CREATE INDEX submissions_status ON submissions (status);

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
