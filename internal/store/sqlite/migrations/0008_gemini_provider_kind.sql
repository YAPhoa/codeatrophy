-- AI providers may be of the kind gemini (the Google Gemini API).
--
-- SQLite cannot change a CHECK constraint, so the table is rebuilt with the
-- same columns and rows, and its triggers are created again. No table
-- refers to ai_providers: ai_usage and ai_log name providers by a plain
-- string id, which the copy keeps.

CREATE TABLE ai_providers_new (
    seq            INTEGER PRIMARY KEY,
    id             TEXT    NOT NULL UNIQUE,
    name           TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    name_key       TEXT    NOT NULL UNIQUE,
    kind           TEXT    NOT NULL CHECK (kind IN ('anthropic', 'gemini', 'openai_compatible')),
    model          TEXT    NOT NULL DEFAULT '',
    base_url       TEXT    NOT NULL DEFAULT '',
    api_key        TEXT    NOT NULL DEFAULT '',
    api_key_origin TEXT    NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

INSERT INTO ai_providers_new (seq, id, name, name_key, kind, model, base_url, api_key, api_key_origin, created_at, updated_at)
SELECT seq, id, name, name_key, kind, model, base_url, api_key, api_key_origin, created_at, updated_at
FROM ai_providers;

DROP TABLE ai_providers;

ALTER TABLE ai_providers_new RENAME TO ai_providers;

-- The kind is fixed at creation.
CREATE TRIGGER ai_providers_kind_immutable BEFORE UPDATE OF kind ON ai_providers
WHEN NEW.kind != OLD.kind
BEGIN
    SELECT RAISE(ABORT, 'the kind of an AI provider cannot be changed');
END;

-- Single-line names.
CREATE TRIGGER ai_providers_name_single_line_insert BEFORE INSERT ON ai_providers
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'AI provider name must be a single line');
END;

CREATE TRIGGER ai_providers_name_single_line_update BEFORE UPDATE OF name ON ai_providers
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'AI provider name must be a single line');
END;

-- At most 20 providers.
CREATE TRIGGER ai_providers_max_count BEFORE INSERT ON ai_providers
WHEN (SELECT COUNT(*) FROM ai_providers) >= 20
BEGIN
    SELECT RAISE(ABORT, 'too many AI providers');
END;
