# Designing a test set

Read this when writing test cases for a problem.

A test set has one job: to tell a correct solution from a plausible wrong one. Think about which wrong solutions someone would actually write, and make sure each of them fails somewhere.

## What to cover

1. **The statement's examples**, as sample cases. They are shown to the solver and used by "Run".
2. **The smallest inputs the constraints allow**: one element, an empty collection where permitted, a single character, `n = 1`, a tree with only a root.
3. **Boundary values**: zero, negative numbers, the largest and smallest values allowed, values that overflow a 32-bit integer when added or multiplied if the bounds permit it.
4. **Degenerate shapes**: all elements equal, already sorted, reverse sorted, one long chain, a star, every answer the same, no valid answer at all (when the statement defines what to print then).
5. **Ties**, whenever the statement has a tie-breaking rule. A test that never exercises the rule cannot check it.
6. **Cases that defeat the usual wrong approach**: the input where greedy fails, where the off-by-one shows, where a visited-set is needed, where duplicates break a hash-map solution.
7. **Large cases** near the upper bounds, so a solution with the wrong complexity times out instead of passing. Add them when the user's `largeTestCase` preference is on (`largeTestCaseCount` of them) or the user asks for them. Write each as a **generator** — a deterministic program that reads nothing and prints the input, given to `add_test_cases` as `generator` in place of `stdin` — never as pasted input; it may print up to `limits.maxLargeInputBytes`. Make them differ in the shape of what they print, not only in a seed: the largest size with arbitrary values, the structure that is the worst case for the obvious slower approach, values at the extremes of their range, a degenerate input (all equal, already sorted, one long run). If the input stays small however large its values are (a single `n` up to 10^12), still make each input different.

The user's `generatedTestCases` preference says how many hidden cases to write. More is not better if the extra cases repeat a category.

## Keeping it honest

- **Every input must satisfy the constraints in the statement.** An input that breaks them tests nothing and makes a correct solution look wrong. If you want a case the constraints forbid, change the constraints first — deliberately.
- **Name cases for what they check** ("all equal", "answer at the last index"), not "Test 3". The name is what the solver sees when a hidden case fails.
- **Mark only the statement's examples as samples.** Hidden cases stay hidden so they cannot be hard-coded.
- **Time limits are for the intended solution, with room.** Check the slowest verified time: if the reference solution uses more than about a third of the limit, the limit is too tight for other languages. If a brute force would also pass the largest case, the case is too small.
- **Exact versus token comparison.** The default comparison ignores whitespace differences. Use exact comparison only when spacing is the point of the problem.

## When expected outputs surprise you

If a verified output is not what you predicted, stop and find out why before moving on. One of three things is true: your prediction was wrong (fine), the reference solution is wrong (fix it and re-verify everything), or the statement is ambiguous (fix the statement, then decide which reading the tests should enforce). Do not just accept the judge's output — it only proves what the solution prints, not that the solution is right.
