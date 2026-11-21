-- Who created an item and who made its last content change, for tracking
-- only: via is the adapter that handled the change ('http', 'mcp' or
-- 'import'), client and model what the caller reported (or the model of the
-- server's own AI work). A record is all or nothing: its via is NULL when
-- it is unknown, as for every item that exists before this migration.
-- created_* are written when the item is inserted and never again.

ALTER TABLE items ADD COLUMN created_via TEXT;
ALTER TABLE items ADD COLUMN created_client TEXT;
ALTER TABLE items ADD COLUMN created_model TEXT;
ALTER TABLE items ADD COLUMN updated_via TEXT;
ALTER TABLE items ADD COLUMN updated_client TEXT;
ALTER TABLE items ADD COLUMN updated_model TEXT;
