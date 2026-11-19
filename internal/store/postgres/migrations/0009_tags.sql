-- Tags are records of their own, so that a tag no item carries any more is
-- kept until it is deleted. Every tag an item carries now becomes one, and
-- item_tags refers to them.

CREATE TABLE tags (
    name text COLLATE "C" NOT NULL PRIMARY KEY
);

INSERT INTO tags (name) SELECT DISTINCT tag FROM item_tags;

ALTER TABLE item_tags ADD CONSTRAINT item_tags_tag_fkey
    FOREIGN KEY (tag) REFERENCES tags (name) DEFERRABLE;
