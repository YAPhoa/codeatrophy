-- What the account page shows of a session: the browser's User-Agent as it
-- was when the session started (at most 256 bytes; '' when unknown, as for
-- every session that exists before this migration), and when the session
-- was last used. last_used_at moves only when the expiry is pushed back, so
-- it is accurate to about an hour; existing sessions start from created_at.

ALTER TABLE sessions
    ADD COLUMN user_agent text COLLATE "C" NOT NULL DEFAULT '',
    ADD COLUMN last_used_at bigint;

UPDATE sessions SET last_used_at = created_at;

ALTER TABLE sessions ALTER COLUMN last_used_at SET NOT NULL;
