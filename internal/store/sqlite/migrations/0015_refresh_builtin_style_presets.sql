-- The built-in style presets are refreshed to use what an item can hold
-- since they were written: collapsed blocks for answers and hints, Mermaid
-- diagrams and display equations. A preset is changed only while it still
-- has its built-in name and exactly the text migration 0005 seeded, so a
-- preset the user edited or renamed is left alone and a deleted one is not
-- inserted again. Its id, default flag and timestamps are kept: making a
-- built-in preset the default changes its updated_at, not its text.

UPDATE style_presets SET instructions =
    'Write the statement the way an interviewer would pose it: two or three short paragraphs in plain language, with no back-story. Name the inputs and say exactly what to return or print. Give two or three small examples, each followed by one or two sentences explaining why that output is correct. Keep the constraints to a short list, chosen so that the intended time complexity matters. Under Notes, add a "Follow-up" line that asks for a better complexity or a harder twist without giving the approach away, then one collapsed "Hint" that points toward the approach without naming it. For a reading: close with "Likely questions", three questions an interviewer might ask, each with its answer collapsed. Starter code in Python and Java.'
WHERE name = 'Interview practice' AND instructions =
    'Write the statement the way an interviewer would pose it: two or three short paragraphs in plain language, with no back-story. Name the inputs and say exactly what to print. Give two or three small examples, each followed by one or two sentences explaining why that output is correct. Keep the constraints to a short list, chosen so that the intended time complexity matters. Under Notes, add a "Follow-up" line that asks for a better complexity or a harder twist without giving the approach away. Starter code in Python and Java.';

UPDATE style_presets SET instructions =
    'Write in the style of a programming-contest problem: a short, concrete scenario of at most one paragraph, then a precise formal statement. Use math notation for every bound, and put a formula the statement defines in a display equation. Choose the limits so that the intended complexity is implied but never named. Give at least two examples and explain only the non-obvious one, under Notes. When that example is a small graph or tree, draw it there as a small Mermaid diagram with plain labels. No hints. Starter code in C++ and Python.'
WHERE name = 'Contest style' AND instructions =
    'Write in the style of a programming-contest problem: a short, concrete scenario of at most one paragraph, then a precise formal statement. Use math notation for every bound. Choose the limits so that the intended complexity is implied but never named. Give at least two examples and explain only the non-obvious one, under Notes. No hints. Starter code in C++ and Python.';

UPDATE style_presets SET instructions =
    'Write for revision rather than for a test. For a reading: open with a two-sentence summary, then short sections with descriptive headings, each with a small worked example or code sample, and close with "Key takeaways" (three to five bullets) and "Check yourself" (three questions, each with its answer collapsed). Where the topic has a flow, a sequence or states, include one small Mermaid diagram. For a problem: keep the statement brief, and use Notes to point to related topics and, in a collapsed "Hint", name the underlying technique, without giving the solution. Prefer plain words to jargon, and define each term the first time it appears.'
WHERE name = 'Study notes' AND instructions =
    'Write for revision rather than for a test. For a reading: open with a two-sentence summary, then short sections with descriptive headings, each with a small worked example or code sample, and close with "Key takeaways" (three to five bullets) and "Check yourself" (three questions without answers). For a problem: keep the statement brief, and use Notes to name the underlying technique and point to related topics without giving the solution. Prefer plain words to jargon, and define each term the first time it appears.';
