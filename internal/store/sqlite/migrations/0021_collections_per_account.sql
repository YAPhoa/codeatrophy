-- Collections are personal: each account keeps its own tree of
-- collections, and so its own memberships of items in them. The library of
-- items stays shared. What exists already goes to the oldest account, or to
-- '' when there is none, as in 0020.

ALTER TABLE collections ADD COLUMN user_id TEXT NOT NULL DEFAULT '';

UPDATE collections SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);

CREATE INDEX collections_user_parent ON collections (user_id, parent_id, position);
