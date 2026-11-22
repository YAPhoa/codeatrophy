-- Personal data per account. An item's status, favorite and notes move to
-- item_states, one row per account and item that differs from the default
-- (todo, not a favorite, no notes). Working copies, submissions, drafts, AI
-- jobs and the AI log record their account in user_id, and preferences
-- are kept per account under "preferences:<user id>". The account '' holds
-- what is kept while no account exists; the first account created takes
-- it over. What exists already goes to the oldest account, or to '' when
-- there is none.

CREATE TABLE item_states (
    user_id  TEXT    NOT NULL,
    item_id  TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    status   TEXT    NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    notes    TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, item_id)
) WITHOUT ROWID;

CREATE INDEX item_states_item_id ON item_states (item_id);

INSERT INTO item_states (user_id, item_id, status, favorite, notes)
SELECT COALESCE((SELECT id FROM users ORDER BY created_at, id LIMIT 1), ''), id, status, favorite, notes
FROM items WHERE status != 'todo' OR favorite != 0 OR notes != '';

ALTER TABLE items DROP COLUMN status;
ALTER TABLE items DROP COLUMN favorite;
ALTER TABLE items DROP COLUMN notes;

CREATE TABLE working_copies_new (
    item_id    TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    language   TEXT    NOT NULL,
    source     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    write_seq  INTEGER NOT NULL,
    user_id    TEXT    NOT NULL,
    PRIMARY KEY (user_id, item_id, language)
) WITHOUT ROWID;

INSERT INTO working_copies_new (item_id, language, source, updated_at, write_seq, user_id)
SELECT item_id, language, source, updated_at, write_seq,
    COALESCE((SELECT id FROM users ORDER BY created_at, id LIMIT 1), '')
FROM working_copies;

DROP TABLE working_copies;
ALTER TABLE working_copies_new RENAME TO working_copies;
CREATE INDEX working_copies_write_seq ON working_copies (write_seq);
CREATE INDEX working_copies_item_id ON working_copies (item_id);

ALTER TABLE submissions ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_jobs ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_log ADD COLUMN user_id TEXT NOT NULL DEFAULT '';

UPDATE submissions SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);
UPDATE drafts SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);
UPDATE ai_jobs SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);
UPDATE ai_log SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);
UPDATE settings SET key = 'preferences:' || (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
WHERE key = 'preferences' AND EXISTS (SELECT 1 FROM users);

CREATE INDEX submissions_user_item ON submissions (user_id, item_id, seq);
CREATE INDEX drafts_user_updated ON drafts (user_id, updated_at, id);
CREATE INDEX ai_jobs_user_newest ON ai_jobs (user_id, created_at, id);
CREATE INDEX ai_log_user_newest ON ai_log (user_id, created_at, id);
