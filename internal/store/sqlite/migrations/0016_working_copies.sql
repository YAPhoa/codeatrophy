-- Working copies: the code the user is writing on a problem, one per
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
    PRIMARY KEY (item_id, language)
) WITHOUT ROWID;

CREATE INDEX working_copies_write_seq ON working_copies (write_seq);
