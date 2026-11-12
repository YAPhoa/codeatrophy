-- Saved solutions. A problem keeps any number of them; at most one is the
-- reference solution, which replaces the reference_* columns of items.

CREATE TABLE solutions (
    seq          INTEGER PRIMARY KEY,
    id           TEXT    NOT NULL UNIQUE,
    item_id      TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    name         TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    language     TEXT    NOT NULL,
    source       TEXT    NOT NULL CHECK (length(source) > 0),
    notes        TEXT    NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
    is_reference INTEGER NOT NULL DEFAULT 0 CHECK (is_reference IN (0, 1)),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
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

-- Existing reference solutions become saved solutions marked as reference,
-- with a random version-4 UUID.
INSERT INTO solutions (id, item_id, name, language, source, notes, is_reference, created_at, updated_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       id, 'Reference solution', reference_language, reference_source, '', 1, updated_at, updated_at
FROM items
WHERE reference_language IS NOT NULL AND reference_source IS NOT NULL AND reference_source != '';

ALTER TABLE items DROP COLUMN reference_language;
ALTER TABLE items DROP COLUMN reference_source;
