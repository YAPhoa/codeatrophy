-- Saved AI providers: named connections to an AI service, each with its own
-- kind, model, base URL and API key. Empty model and base URL mean the
-- kind's default. api_key is ciphertext bound to (kind, api_key_origin); it
-- is empty when no key is stored.
--
-- The single per-kind settings that came before (ai.<kind>.* and
-- ai.active_provider in settings) are carried over into rows by the server
-- at startup, where the environment they were merged with is known.

CREATE TABLE ai_providers (
    seq            INTEGER PRIMARY KEY,
    id             TEXT    NOT NULL UNIQUE,
    name           TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    name_key       TEXT    NOT NULL UNIQUE,
    kind           TEXT    NOT NULL CHECK (kind IN ('anthropic', 'openai_compatible')),
    model          TEXT    NOT NULL DEFAULT '',
    base_url       TEXT    NOT NULL DEFAULT '',
    api_key        TEXT    NOT NULL DEFAULT '',
    api_key_origin TEXT    NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

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
