-- A saved solution keeps the figures of its last run on the test cases:
-- how many cases passed out of how many, the slowest case's time and the
-- peak memory (NULL when the judge measured nothing), and when it ran. All
-- are NULL for a solution that has not been run since its code last
-- changed, which every existing solution starts as.

ALTER TABLE solutions
    ADD COLUMN last_run_passed bigint CONSTRAINT solutions_last_run_passed CHECK (last_run_passed >= 0),
    ADD COLUMN last_run_total bigint CONSTRAINT solutions_last_run_total CHECK (last_run_total >= 0),
    ADD COLUMN last_run_time_ms bigint CONSTRAINT solutions_last_run_time_ms CHECK (last_run_time_ms >= 0),
    ADD COLUMN last_run_memory_kb bigint CONSTRAINT solutions_last_run_memory_kb CHECK (last_run_memory_kb >= 0),
    ADD COLUMN last_run_at bigint,
    ADD CONSTRAINT solutions_last_run CHECK (
        CASE WHEN last_run_at IS NULL
            THEN last_run_passed IS NULL AND last_run_total IS NULL AND last_run_time_ms IS NULL AND last_run_memory_kb IS NULL
            ELSE last_run_passed IS NOT NULL AND last_run_total IS NOT NULL AND last_run_passed <= last_run_total
        END);
