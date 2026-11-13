-- Built-in style presets for a new instance. They are ordinary rows: fully
-- editable and deletable, and counted against the limit of 20. They are
-- seeded only when no preset exists yet, so an instance that already has
-- presets is left alone, and, like every migration, this runs once: a
-- deleted seed never comes back.
--
-- The rows are collected first (with a random version-4 UUID each) and then
-- inserted, so the emptiness check is made once, before any insert.

CREATE TEMP TABLE seed_style_presets AS
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) AS id,
       ord, name, instructions, is_default,
       CAST(strftime('%s', 'now') AS INTEGER) AS ts
FROM (
    SELECT 1 AS ord, 'Interview practice' AS name, 1 AS is_default,
        'Write the statement the way an interviewer would pose it: two or three short paragraphs in plain language, with no back-story. Name the inputs and say exactly what to print. Give two or three small examples, each followed by one or two sentences explaining why that output is correct. Keep the constraints to a short list, chosen so that the intended time complexity matters. Under Notes, add a "Follow-up" line that asks for a better complexity or a harder twist without giving the approach away. Starter code in Python and Java.' AS instructions
    UNION ALL
    SELECT 2, 'Contest style', 0,
        'Write in the style of a programming-contest problem: a short, concrete scenario of at most one paragraph, then a precise formal statement. Use math notation for every bound. Choose the limits so that the intended complexity is implied but never named. Give at least two examples and explain only the non-obvious one, under Notes. No hints. Starter code in C++ and Python.'
    UNION ALL
    SELECT 3, 'Study notes', 0,
        'Write for revision rather than for a test. For a reading: open with a two-sentence summary, then short sections with descriptive headings, each with a small worked example or code sample, and close with "Key takeaways" (three to five bullets) and "Check yourself" (three questions without answers). For a problem: keep the statement brief, and use Notes to name the underlying technique and point to related topics without giving the solution. Prefer plain words to jargon, and define each term the first time it appears.'
)
WHERE NOT EXISTS (SELECT 1 FROM style_presets);

INSERT INTO style_presets (id, name, name_key, instructions, is_default, created_at, updated_at)
SELECT id, name, lower(name), instructions, is_default, ts, ts FROM seed_style_presets ORDER BY ord;

DROP TABLE seed_style_presets;
