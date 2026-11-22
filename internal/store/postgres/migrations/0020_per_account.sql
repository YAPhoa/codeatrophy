-- Personal data per account. An item's status, favorite and notes move to
-- item_states, one row per account and item that differs from the default
-- (todo, not a favorite, no notes). Working copies, submissions, drafts, AI
-- jobs and the AI log record their account in user_id, and preferences
-- are kept per account under "preferences:<user id>". The account '' holds
-- what is kept while no account exists; the first account created takes
-- it over. What exists already goes to the oldest account, or to '' when
-- there is none.

CREATE TABLE item_states (
    user_id  text    COLLATE "C" NOT NULL,
    item_id  text    COLLATE "C" NOT NULL REFERENCES items (id) ON DELETE CASCADE DEFERRABLE,
    status   text    COLLATE "C" NOT NULL,
    favorite boolean NOT NULL DEFAULT false,
    notes    bytea   NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, item_id)
);

CREATE INDEX item_states_item_id ON item_states (item_id);

INSERT INTO item_states (user_id, item_id, status, favorite, notes)
SELECT COALESCE((SELECT id FROM users ORDER BY created_at, id LIMIT 1), ''), id, status, favorite, notes
FROM items WHERE status <> 'todo' OR favorite OR notes <> ''::bytea;

ALTER TABLE items DROP COLUMN status, DROP COLUMN favorite, DROP COLUMN notes;

ALTER TABLE working_copies ADD COLUMN user_id text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN user_id text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN user_id text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE ai_jobs ADD COLUMN user_id text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE ai_log ADD COLUMN user_id text COLLATE "C" NOT NULL DEFAULT '';

UPDATE working_copies SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);
UPDATE submissions SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);
UPDATE drafts SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);
UPDATE ai_jobs SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);
UPDATE ai_log SET user_id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1) WHERE EXISTS (SELECT 1 FROM users);
UPDATE settings SET key = 'preferences:' || (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
WHERE key = 'preferences' AND EXISTS (SELECT 1 FROM users);

ALTER TABLE working_copies DROP CONSTRAINT working_copies_pkey, ADD PRIMARY KEY (user_id, item_id, language);
CREATE INDEX working_copies_item_id ON working_copies (item_id);
CREATE INDEX submissions_user_item ON submissions (user_id, item_id, seq);
CREATE INDEX drafts_user_updated ON drafts (user_id, updated_at, id);
CREATE INDEX ai_jobs_user_newest ON ai_jobs (user_id, created_at, id);
CREATE INDEX ai_log_user_newest ON ai_log (user_id, created_at, id);
