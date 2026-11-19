-- Tags are records of their own, so that a tag no item carries any more is
-- kept until it is deleted. Every tag an item carries now becomes one.
--
-- item_tags then refers to tags. SQLite cannot add a foreign key to a
-- table, so item_tags is rebuilt with the same rows and its index created
-- again. No table refers to item_tags.

CREATE TABLE tags (
    name TEXT NOT NULL PRIMARY KEY
) WITHOUT ROWID;

INSERT INTO tags (name) SELECT DISTINCT tag FROM item_tags;

CREATE TABLE item_tags_new (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    tag     TEXT NOT NULL REFERENCES tags (name),
    PRIMARY KEY (item_id, tag)
) WITHOUT ROWID;

INSERT INTO item_tags_new (item_id, tag) SELECT item_id, tag FROM item_tags;

DROP TABLE item_tags;

ALTER TABLE item_tags_new RENAME TO item_tags;

CREATE INDEX item_tags_tag ON item_tags (tag);
