-- Each AI provider has an effort level: low, medium or high, or NULL for
-- the model's own default, in which case none is sent. Until now the server
-- asked Anthropic models for high, so Anthropic providers keep that; the
-- other kinds sent none.

ALTER TABLE ai_providers ADD COLUMN effort TEXT CHECK (effort IN ('low', 'medium', 'high'));

UPDATE ai_providers SET effort = 'high' WHERE kind = 'anthropic';
