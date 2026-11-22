-- Bearer tokens an account makes for its MCP clients. id is the SHA-256
-- hash (hex) of the token; the token itself is never stored. hint holds its
-- last characters, to tell tokens apart in a list.

CREATE TABLE mcp_tokens (
    id           text   COLLATE "C" PRIMARY KEY,
    user_id      text   COLLATE "C" NOT NULL REFERENCES users (id) ON DELETE CASCADE DEFERRABLE,
    name         text   COLLATE "C" NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    hint         text   COLLATE "C" NOT NULL,
    created_at   bigint NOT NULL,
    last_used_at bigint
);

CREATE INDEX mcp_tokens_user_id ON mcp_tokens (user_id);
