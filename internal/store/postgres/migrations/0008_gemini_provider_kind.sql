-- AI providers may be of the kind gemini (the Google Gemini API). The kind
-- check was declared on the column, so it carries PostgreSQL's default
-- name; it is replaced under the same name.

ALTER TABLE ai_providers DROP CONSTRAINT ai_providers_kind_check;
ALTER TABLE ai_providers ADD CONSTRAINT ai_providers_kind_check
    CHECK (kind IN ('anthropic', 'gemini', 'openai_compatible'));
