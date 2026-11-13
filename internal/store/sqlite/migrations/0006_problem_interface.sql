-- Solution-only problems. problem_interface says what the solver writes:
-- 'program' (a complete program) or 'function' (only the solution, which
-- the hidden per-language runner code in harness turns into a program).
-- harness is a JSON object keyed by language id, each entry
-- {"prefix": ..., "suffix": ...}. Both are NULL for readings; existing
-- problems become programs without a harness.
--
-- A submission keeps the runner it ran in (NULL for a program problem) and
-- how many lines that runner put before the submitted source.

ALTER TABLE items ADD COLUMN problem_interface TEXT CHECK (problem_interface IN ('program', 'function'));
ALTER TABLE items ADD COLUMN harness TEXT;
UPDATE items SET problem_interface = 'program', harness = '{}' WHERE type = 'problem';

ALTER TABLE submissions ADD COLUMN line_offset INTEGER NOT NULL DEFAULT 0 CHECK (line_offset >= 0);
ALTER TABLE submissions ADD COLUMN harness TEXT;
