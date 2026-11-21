-- foreign_keys=off
--
-- Items can be linked to each other, and a link stays when either item is
-- deleted, as variantOf does from now on: a deleted item leaves a record of
-- its id, title and type so that what still names it can show it.
--
-- variantOf no longer refers to items, so that it survives the deletion of
-- the origin. SQLite cannot drop a foreign key, so items is rebuilt with
-- the same rows (keeping seq, which the search index uses as its rowid) and
-- its indexes are created again. The tables that refer to items keep
-- referring to it by name; this migration runs with foreign key
-- enforcement off (see the migration runner), so dropping the old table
-- deletes nothing, and the runner checks the foreign keys before
-- committing.

CREATE TABLE items_new (
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
    variant_of         TEXT,
    revision           INTEGER NOT NULL DEFAULT 1,
    time_limit_ms      INTEGER,
    memory_limit_kb    INTEGER,
    compare_mode       TEXT,
    starter_code       TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    problem_interface  TEXT CHECK (problem_interface IN ('program', 'function')),
    harness            TEXT
);

INSERT INTO items_new (seq, id, type, title, summary, body, difficulty, status, favorite, notes, raw_input,
    source_url, source_note, variant_of, revision, time_limit_ms, memory_limit_kb, compare_mode, starter_code,
    created_at, updated_at, problem_interface, harness)
SELECT seq, id, type, title, summary, body, difficulty, status, favorite, notes, raw_input,
    source_url, source_note, variant_of, revision, time_limit_ms, memory_limit_kb, compare_mode, starter_code,
    created_at, updated_at, problem_interface, harness
FROM items;

DROP TABLE items;

ALTER TABLE items_new RENAME TO items;

CREATE INDEX items_variant_of ON items (variant_of);
CREATE INDEX items_updated_at ON items (updated_at);
CREATE INDEX items_created_at ON items (created_at);

-- One row per linked pair, the smaller id first. Neither id refers to
-- items: a link outlives its items.
CREATE TABLE item_links (
    seq        INTEGER PRIMARY KEY,
    item_a     TEXT    NOT NULL,
    item_b     TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (item_a, item_b),
    CHECK (item_a < item_b)
);

CREATE INDEX item_links_b ON item_links (item_b);

-- What is kept of a deleted item, until an item with its id is created
-- again.
CREATE TABLE deleted_items (
    id         TEXT    NOT NULL PRIMARY KEY,
    title      TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    deleted_at INTEGER NOT NULL
) WITHOUT ROWID;
