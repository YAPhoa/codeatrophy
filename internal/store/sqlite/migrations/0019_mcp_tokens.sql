-- Bearer tokens an account makes for its MCP clients. id is the SHA-256
-- hash (hex) of the token; the token itself is never stored. hint holds its
-- last characters, to tell tokens apart in a list.

CREATE TABLE mcp_tokens (
    id           TEXT    PRIMARY KEY,
    user_id      TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    hint         TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
) WITHOUT ROWID;

CREATE INDEX mcp_tokens_user_id ON mcp_tokens (user_id);
