import { expect, test, type Locator, type Page } from '@playwright/test';
import { choose, open, openList } from './support';

// A short smoke suite over the flows the product stands on. It runs
// against the API mock, whose state lives in the page: every test starts from
// the seed library, and navigation inside a test must stay client-side (a
// reload would reset the mock).

test('capture: rough text becomes a reviewed, saved problem', async ({ page }) => {
  await open(page, '/new');

  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('button', { name: 'Draft with AI' }).click();

  // Review: the draft is complete, says what was assumed, and nothing is saved yet.
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  await expect(page.getByLabel('Title')).not.toHaveValue('');
  await expect(page.getByRole('region', { name: /assum|filled in/i })).toBeVisible();

  // A revision reworks the draft in place. Its form is folded until asked for.
  await expect(page.getByLabel('What to change')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask for a revision' }).click();
  await page.getByLabel('What to change').fill('use 1-based indices');
  await page.getByRole('button', { name: 'Revise draft' }).click();
  await expect(page.getByText('Revising the draft…')).toBeHidden();

  await page.getByLabel('Title').fill('Two Sum (smoke test)');
  await page.getByRole('button', { name: 'Save to library' }).first().click();

  // Saved, with the next steps on offer.
  await expect(page).toHaveURL(/\/items\/[^/]+\/saved$/);
  await expect(page.getByRole('heading', { name: 'Two Sum (smoke test)' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Generate test cases' })).toBeVisible();

  // And it is in the library.
  await page.getByRole('link', { name: /^All items/ }).click();
  await expect(page.getByRole('link', { name: 'Two Sum (smoke test)' })).toBeVisible();
});

test('solution only: the runner and the AI\'s solution stay out of sight from capture to solving', async ({ page }) => {
  await open(page, '/new');

  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('radiogroup', { name: 'What you write' }).getByText('Solution only').click();
  await page.getByRole('button', { name: 'Draft with AI' }).click();

  // Review: the stub is there to edit, the runner is closed, and the solution is hidden behind its check.
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'What you write' }).getByRole('radio', { name: 'Solution only' })).toBeChecked();
  await expect(page.getByText('def twoSum(self, nums')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Runner/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('sys.stdin')).toHaveCount(0);
  await expect(page.getByText('Python, written by the AI')).toBeVisible();
  await expect(page.getByText('Passes 2 of 2 test cases')).toBeVisible();
  await expect(page.getByText('seen = {}')).toHaveCount(0);
  // Each language's runner was proven, and the generation says what it cost.
  await expect(page.getByRole('tab', { name: /Python\s*runner ran/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Go\s*runner ran/ })).toBeVisible();
  await expect(page.locator('.usage-line')).toHaveText(/^claude-opus-5-5 · [\d.]+k in · \d+ out · \d+\u00a0s$/);

  await page.getByLabel('Title').fill('Two Sum (solution only)');
  await page.getByRole('button', { name: 'Save to library' }).first().click();
  await expect(page).toHaveURL(/\/items\/[^/]+\/saved$/);

  // The saved reference solution is tested without its code being shown.
  await page.getByRole('button', { name: 'Test it' }).click();
  await expect(page.getByText('Passes 2 of 2 test cases')).toBeVisible();
  await expect(page.getByText('seen = {}')).toHaveCount(0);

  // Solving starts from the stub, in a language that has a runner.
  await page.getByRole('link', { name: 'Open and solve' }).click();
  await expect(page.locator('.editor-host .cm-content')).toContainText('def twoSum(self, nums');
  await expect(page.locator('.editor-host .cm-content')).not.toContainText('sys.stdin');
  const languages = (await openList(page.getByRole('combobox', { name: 'Language' }))).getByRole('option');
  // The default style keeps Python and Go, each with its runner.
  await expect(languages).toHaveCount(2);
  await expect(languages).toContainText(['Go', 'Python']);
  await page.keyboard.press('Escape');

  // The runner is one click away, folded around the solver's code.
  const editor = page.locator('.editor-host');
  const after = editor.getByRole('button', { name: /^Runner · \d+ lines?, after your code$/ });
  await expect(after).toHaveAttribute('aria-expanded', 'false');
  await after.click();
  await expect(after).toHaveAttribute('aria-expanded', 'true');
  await expect(editor.getByText('sys.stdin')).toBeVisible();
});

test('solve: the runner of a "solution only" problem sits folded around the code, outside it', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Merge k Sorted Lists' }).click();

  // One collapsed row above the code and one below it.
  const editor = page.locator('.editor-host');
  const before = editor.getByRole('button', { name: /^Runner · \d+ lines?, before your code$/ });
  const after = editor.getByRole('button', { name: /^Runner · \d+ lines?, after your code$/ });
  await expect(before).toHaveAttribute('aria-expanded', 'false');
  await expect(after).toHaveAttribute('aria-expanded', 'false');
  await expect(editor.getByText('import json')).toHaveCount(0);

  // Expanded, the runner is shown in place; the code that would be submitted is still only the solver's.
  await before.click();
  await expect(before).toHaveAttribute('aria-expanded', 'true');
  await expect(editor.getByText('import json')).toBeVisible();
  const lines = editor.locator('.cm-line');
  await expect(lines.first()).toHaveText('# Definition for singly-linked list.');
  expect((await lines.allTextContents()).join('\n')).not.toContain('import json');
  await expect(editor.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: /^1$/ })).toBeVisible();

  // It folds away again from the keyboard.
  await before.focus();
  await page.keyboard.press('Enter');
  await expect(before).toHaveAttribute('aria-expanded', 'false');
  await expect(editor.getByText('import json')).toHaveCount(0);
});

test('solve: the lines that read the input open folded, and unfold in place', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Number of Islands' }).click();

  const editor = page.locator('.editor-host');
  await expect(editor.locator('.cm-line').filter({ hasText: '# region input' })).toBeVisible();
  await expect(editor.getByText('sys.stdin')).toHaveCount(0);
  await expect(editor.getByText('print(count_islands(grid))')).toBeVisible();

  await editor.locator('.cm-foldPlaceholder').click();
  await expect(editor.getByText('sys.stdin.read()')).toBeVisible();
  await expect(editor.locator('.cm-foldPlaceholder')).toHaveCount(0);

  // Opened in another language, its region is folded again.
  await choose(page.getByRole('combobox', { name: 'Language' }), /^C\+\+/);
  await expect(editor.locator('.cm-line').filter({ hasText: '// region input' })).toBeVisible();
  await expect(editor.getByText('cin >> rows')).toHaveCount(0);
});

test('test cases to generate: the preference is where the generate page starts', async ({ page }) => {
  await open(page, '/settings/preferences');

  await expect(page.getByLabel('Test cases to generate', { exact: true })).toHaveValue('8');
  await page.getByRole('button', { name: 'More test cases' }).click();
  await page.getByLabel('Test cases to generate', { exact: true }).fill('12');
  await page.getByLabel('Test cases to generate', { exact: true }).blur();

  await page.getByRole('link', { name: /^All items/ }).click();
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  await page.getByRole('link', { name: /Generate/ }).first().click();
  await expect(page.getByLabel('How many')).toHaveValue('12');

  // It can still be changed for one run.
  await page.getByRole('button', { name: 'Fewer test cases' }).click();
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await expect(page.getByText(/\d+ of 11 selected/)).toBeVisible();
  await expect(page.locator('.proposal-head .usage-line')).toContainText('claude-opus-5-5');
  // The proposed solution is hidden as well, with what running it found.
  await expect(page.getByRole('button', { name: 'Show solution' })).toBeVisible();
  await expect(page.locator('.solution-found')).toContainText(/inputs/);
});

/** Replace the code in the solving editor. */
test('new item: starts as the type being browsed, and takes the tags the draft suggests', async ({ page }) => {
  await open(page, '/');
  const nav = page.getByRole('complementary', { name: 'Navigation' });
  const kind = page.getByRole('radiogroup', { name: 'Kind of item' });

  // From the readings, a new item is a reading; the preset is used once and leaves the URL.
  await nav.getByRole('link', { name: /Readings/ }).click();
  await nav.getByRole('link', { name: /New item/ }).click();
  await expect(kind.getByRole('radio', { name: 'Reading' })).toBeChecked();
  await expect(page).not.toHaveURL(/type=/);

  // From the problems, a problem.
  await nav.getByRole('link', { name: /Problems/ }).click();
  await nav.getByRole('link', { name: /New item/ }).click();
  await expect(kind.getByRole('radio', { name: 'Problem' })).toBeChecked();

  // From the unfiltered library the last choice is left alone.
  await kind.getByText('Auto-detect').click();
  await nav.getByRole('link', { name: 'All items' }).click();
  await nav.getByRole('link', { name: /New item/ }).click();
  await expect(kind.getByRole('radio', { name: 'Auto-detect' })).toBeChecked();

  // The tags the draft suggests are on the form, and on the saved item.
  await page.getByLabel('What you have').fill('shortest path in a weighted graph, the one with the heap');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove tag graph' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove tag heap' })).toBeVisible();

  await page.getByRole('button', { name: 'Save to library' }).first().click();
  await expect(page).toHaveURL(/\/items\/[^/]+\/saved$/);
  const saved = page.getByRole('status').filter({ hasText: 'Saved to your library' });
  await expect(saved.getByRole('link', { name: /graph$/ })).toBeVisible();
  await expect(saved.getByRole('link', { name: /heap$/ })).toBeVisible();
});

async function writeCode(page: Page, source: string): Promise<void> {
  await page.getByRole('textbox', { name: /solution code/i }).click();
  await page.keyboard.press('ControlOrMeta+A');
  // Inserted as one piece of text, so that bracket closing and completion do not reshape it.
  await page.keyboard.insertText(source);
}

test('solve: the editor has the room, and a failing submission shows which case and why', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();

  // Tests and results start as a slim bar under the editor, and the navigation as a rail.
  const drawerBar = page.getByRole('button', { name: 'Show tests and results' });
  await expect(drawerBar).toBeVisible();
  await expect(page.getByRole('button', { name: /^Expand navigation/ })).toBeVisible();

  // The mock judge reads its verdict from a marker in the source.
  await writeCode(page, 'import sys\n\ns = sys.stdin.readline().strip()\nprint(len(set(s)))  # MOCK:WA\n');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();

  // Submitting opens the drawer on the result.
  const result = page.getByRole('status').filter({ hasText: /passed/ });
  await expect(result).toContainText('Wrong answer');
  await expect(result).toContainText(/Ran \d+ test cases: \d+ passed/);

  // A failing sample case is opened with expected and actual output side by side.
  await expect(page.getByRole('button', { name: /^Case \d+, .*: Wrong answer$/ }).first()).toBeVisible();
  await expect(page.getByText('Expected', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Your output|Actual/).first()).toBeVisible();

  // A failing hidden case shows its verdict but not its content, until it is revealed.
  await page.getByRole('button', { name: /^Case \d+: Wrong answer$/ }).first().click();
  const panel = page.getByRole('tabpanel', { name: 'Result' });
  await expect(panel.getByText('kept out of sight')).toBeVisible();
  await expect(panel.getByText('Input', { exact: true })).toBeHidden();
  await panel.getByRole('button', { name: 'Reveal this case' }).click();
  await expect(panel.getByText('Input', { exact: true })).toBeVisible();

  // The drawer goes back to a bar from the keyboard, and the bar keeps the verdict in view.
  await page.getByRole('textbox', { name: /solution code/i }).click();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(drawerBar).toBeVisible();
  await expect(page.locator('.drawer-bar')).toContainText('Wrong answer');

  // So does the statement, which leaves the whole width to the editor.
  await page.keyboard.press('ControlOrMeta+E');
  const statementBar = page.getByRole('button', { name: 'Show the statement' });
  await expect(statementBar).toBeVisible();
  await statementBar.click();

  // The attempt is in the history.
  await page.getByRole('tab', { name: /Submissions/ }).click();
  await expect(page.getByRole('tabpanel').getByText('Wrong answer').first()).toBeVisible();
});

test('solve: the history lists submissions under column names, and runs are not kept there', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  await page.getByRole('tab', { name: /Submissions/ }).click();
  const history = page.getByRole('tabpanel', { name: 'Submissions' });
  const head = history.locator('.history-head');
  for (const name of ['Status', 'Language', 'Passed', 'Runtime', 'Memory', 'Submitted']) await expect(head.getByText(name, { exact: true })).toBeVisible();
  // The seed has a run and two submissions here; only the submissions are listed, each row naming its numbers.
  const rows = history.locator('.history-row');
  await expect(rows).toHaveCount(2);
  await expect(history.getByRole('button', { name: /^Wrong answer Python Passed \d+\/\d+ Runtime \d+ ms Memory [\d.]+ MB/ })).toBeVisible();

  // A run shows its result, and stays out of the history.
  await writeCode(page, 'import sys\n\nprint(len(sys.stdin.readline()))\n');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const result = page.getByRole('status').filter({ hasText: /passed/ });
  await expect(result).toContainText(/Ran \d+ sample cases?: .*passed/);
  await expect(rows).toHaveCount(2);

  // A submission is added at the top.
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(result).toContainText(/Ran \d+ test cases: .*passed/);
  await page.getByRole('dialog', { name: 'Save as a solution' }).getByRole('button', { name: 'Not now' }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Accepted');
  await expect(rows.first()).toContainText('just now');
});

test('solve: the custom input of a problem survives a reload', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('button', { name: 'Show tests and results' }).click();
  await page.getByRole('tab', { name: 'Custom input' }).click();
  const input = page.getByLabel('Standard input for one run');
  await input.fill('4\n2 7 11 15\n9\n');
  // It is stored shortly after typing stops.
  const stored = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('codeatrophy:stdin:')).map((k) => localStorage.getItem(k)));
  await expect.poll(stored).toEqual(['4\n2 7 11 15\n9\n']);

  // The mock starts afresh on a reload; what the browser keeps does not.
  await page.reload();
  await expect(page.getByLabel('Standard input for one run')).toHaveValue('4\n2 7 11 15\n9\n');

  // It is kept per problem.
  await page.getByRole('button', { name: /^Expand navigation/ }).click();
  await page.getByRole('link', { name: /^All items/ }).click();
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  await page.getByRole('tab', { name: 'Custom input' }).click();
  await expect(page.getByLabel('Standard input for one run')).toHaveValue('');
});

test('solutions: an accepted submission is kept, and can become the reference', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();

  await writeCode(page, 'import sys\n\nprint(len(sys.stdin.readline()))\n');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const result = page.getByRole('status').filter({ hasText: /passed/ });
  await expect(result).toContainText('Accepted');

  // An accepted submission asks to be kept, under a name of the solver's choosing.
  const dialog = page.getByRole('dialog', { name: 'Save as a solution' });
  await expect(dialog).toContainText('Accepted. Keep this code with the problem?');
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toHaveCount(0);

  // Declined, it is still offered next to the verdict.
  await result.getByRole('button', { name: 'Save as solution' }).click();
  await dialog.getByLabel('Name').fill('Smoke test solution');
  await dialog.getByRole('button', { name: 'Save solution' }).click();
  await expect(result).toContainText('Saved as a solution');

  // It is listed with the problem's solutions, with its code out of sight until asked for.
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Solutions/ }).click();
  const saved = page.getByRole('article').filter({ hasText: 'Smoke test solution' });
  await expect(saved).toBeVisible();
  await expect(saved.getByRole('textbox')).toHaveCount(0);
  await saved.getByRole('button', { name: 'Show solution' }).click();
  await expect(saved.getByRole('textbox')).toContainText('sys.stdin.readline');

  // Making it the reference moves the mark, and test verification follows.
  await saved.getByRole('button', { name: 'Use as reference' }).click();
  await expect(saved.getByText('Reference', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  await expect(page.getByRole('region', { name: 'Verification' })).toContainText(/Reference solution\s*Smoke test solution/);

  // Submitted again, the same code is not offered for saving: the verdict says where it already is.
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: 'Solve' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(result).toContainText('Accepted');
  await expect(result.getByRole('link', { name: 'Already saved as “Smoke test solution”' })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(result.getByRole('button', { name: 'Save as solution' })).toHaveCount(0);
});

test('preferences: hidden test cases and editor options follow the settings', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();

  // By default the hidden cases are counted but not shown.
  await page.getByRole('button', { name: /^Tests/ }).click();
  await expect(page.getByText(/\d+ test cases · \d+ shown as examples/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reveal all' })).toBeVisible();
  // A revealed case can be hidden again: a Hide button takes the place of its "hidden" tag.
  const caseList = page.locator('.tcases');
  const revealOne = caseList.getByRole('button', { name: /^Reveal case \d+$/ }).first();
  const n = (await revealOne.getAttribute('aria-label'))!.replace('Reveal case ', '');
  await revealOne.click();
  await caseList.getByRole('button', { name: `Hide case ${n}` }).click();
  await expect(caseList.getByRole('button', { name: `Reveal case ${n}` })).toBeVisible();
  const editorLine = page.locator('.editor-host .cm-line').first();
  await expect(editorLine).toHaveCSS('font-size', '14px');

  await page.getByRole('button', { name: /^Expand navigation/ }).click();
  await page.getByRole('list', { name: 'Manage' }).getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Preferences' }).click();
  await page.getByRole('checkbox', { name: 'Hide test cases by default' }).uncheck();
  await page.getByRole('button', { name: 'Larger font' }).click();
  await page.getByRole('button', { name: 'Larger font' }).click();
  await expect(page.getByLabel('Font size')).toHaveValue('16');

  // Back on the problem, every case is shown and the editor uses the new size.
  await page.getByRole('link', { name: /^All items/ }).click();
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  await expect(page.locator('.editor-host .cm-line').first()).toHaveCSS('font-size', '16px');
  // The drawer was opened by hand earlier, and that is remembered.
  await expect(page.getByRole('tab', { name: /^Tests/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/\d+ test cases · \d+ samples, \d+ hidden/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reveal all' })).toHaveCount(0);
});

/** Nothing on the page, in a field or as text, holds a large test case in full. */
async function expectNoLargeText(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.body.innerText.length)).toBeLessThan(100_000);
  expect(await page.locator('textarea').evaluateAll((areas) => Math.max(0, ...areas.map((a) => (a as HTMLTextAreaElement).value.length)))).toBeLessThan(10_000);
}

test('large test cases: the preferences ask for them with every draft, kept out of sight', async ({ page }) => {
  await open(page, '/settings/preferences');
  const preference = page.getByRole('checkbox', { name: 'Generate large test cases by default' });
  await expect(preference).not.toBeChecked();
  await preference.check();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  // How many is a preference of its own.
  const count = page.getByLabel('Large test cases to generate');
  await expect(count).toHaveValue('3');
  await page.getByRole('button', { name: 'Fewer large test cases' }).click();
  await expect(count).toHaveValue('2');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: /New item/ }).click();
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();

  // After the other cases, a line sums them up; the large cases follow it on request.
  const section = page.locator('section[aria-labelledby="cases-heading"]');
  const outcomes = section.getByRole('region', { name: 'Large test cases' });
  const summary = outcomes.getByRole('status');
  const show = outcomes.getByRole('button', { name: 'Show large cases' });
  const showAll = async () => {
    if (await show.isVisible()) await show.click();
  };
  const cards = section.locator('.case-card');
  const largeCards = section.locator('.large-cases + .case-cards .case-card');
  await expect(summary).toHaveText('2 large cases generated');
  await expect(section.locator('.case-cards + .large-cases')).toHaveCount(1);
  await expect(cards).toHaveCount(2);
  await expect(largeCards).toHaveCount(0);
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('random.seed')).toHaveCount(0);
  // What a revision does to them is said behind an "i".
  await outcomes.getByRole('button', { name: 'About large cases' }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Regenerated when the AI revises the draft.');
  await page.mouse.move(0, 0);

  // Opened, each is a card numbered after the others: its name, its generator, then its data, which only shows its size.
  await show.click();
  await expect(largeCards).toHaveCount(2);
  await expect(cards).toHaveCount(4);
  await expect(outcomes.getByRole('listitem')).toHaveCount(0);
  const card = largeCards.first();
  const name = card.getByRole('textbox', { name: 'Name of case 3' });
  const generator = card.getByRole('textbox', { name: /^Generator of case 3, Python/ });
  const input = card.getByRole('group', { name: 'Input (stdin)' });
  const output = card.getByRole('group', { name: 'Expected output' });
  await expect(generator).toContainText('random.seed(');
  await expect(input).toContainText(/Too large to show or edit · \d+\u00a0KB · \d+ lines?/);
  // Even an output of a few bytes is not edited in place.
  await expect(output).toContainText(/Too large to show or edit · \d+\u00a0B · 1 line/);
  const top = async (l: Locator) => (await l.boundingBox())!.y;
  expect(await top(name)).toBeLessThan(await top(generator));
  expect(await top(generator)).toBeLessThan(await top(input));
  await expect(card.locator('textarea')).toHaveCount(0);
  await expect(card.locator('.case-io').getByText('30000')).toHaveCount(0);
  await expect(largeCards.nth(1).getByRole('textbox', { name: 'Name of case 4' })).toBeVisible();
  await expectNoLargeText(page);
  const download = page.waitForEvent('download');
  await input.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toMatch(/-input\.txt$/);

  // Clear is the way to replace a value: the field is then typed in like any other.
  await output.getByRole('button', { name: 'Clear' }).click();
  await card.getByLabel('Expected output').fill('42');
  await expect(card.getByLabel('Expected output')).toHaveValue('42');
  await expect(input).toContainText('Too large to show or edit');

  // A generator stays with its case when another goes, and when it comes back.
  const secondGenerator = await largeCards.nth(1).getByRole('textbox', { name: /^Generator of case 4/ }).textContent();
  const firstGenerator = await generator.textContent();
  expect(secondGenerator).not.toBe(firstGenerator);
  await card.getByRole('button', { name: 'Remove case 3' }).click();
  await expect(largeCards).toHaveCount(1);
  await expect(largeCards.first().getByRole('textbox', { name: /^Generator of case 3/ })).toHaveText(secondGenerator!);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(largeCards).toHaveCount(2);
  await expect(largeCards.first().getByRole('textbox', { name: /^Generator of case 3/ })).toHaveText(firstGenerator!);
  await expect(largeCards.nth(1).getByRole('textbox', { name: /^Generator of case 4/ })).toHaveText(secondGenerator!);
  // A case added by hand goes before them.
  await section.getByRole('button', { name: 'Add case' }).click();
  await expect(section.locator('.case-cards').first().locator('.case-card')).toHaveCount(3);
  await expect(section.getByRole('textbox', { name: 'Name of case 3' })).toHaveValue('Example 3');
  await expect(largeCards.first().getByRole('textbox', { name: 'Name of case 4' })).toBeVisible();
  await section.getByRole('button', { name: 'Remove case 3' }).click();
  await outcomes.getByRole('button', { name: 'Hide large cases' }).click();
  await expect(largeCards).toHaveCount(0);

  // A revision asks again, and the cases come back rather than adding up.
  await page.getByRole('button', { name: 'Ask for a revision' }).click();
  await page.getByLabel('What to change').fill('use 1-based indices');
  await page.getByRole('button', { name: 'Revise draft' }).click();
  await expect(page.getByText('Revising the draft…')).toBeHidden();
  await expect(summary).toHaveText('2 large cases generated');
  await showAll();
  await expect(largeCards).toHaveCount(2);

  // Some added and one not: the model wrote one generator fewer than asked for. Only the one without a card has a line.
  await page.getByRole('button', { name: 'Back to input' }).click();
  await page.getByLabel('What you have').fill('two sum, array and target MOCK:LARGE-SHORT');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(summary).toHaveText('1 of 2 large cases generated');
  await showAll();
  await expect(outcomes.getByRole('listitem')).toHaveText(['Large case not added. The model wrote fewer generators than asked for.']);
  await expect(page.getByRole('textbox', { name: /^Generator of / })).toHaveCount(1);
  await expect(largeCards).toHaveCount(1);

  // Large cases that could not be built are reported, and nothing is added.
  await page.getByRole('button', { name: 'Back to input' }).click();
  await page.getByLabel('What you have').fill('two sum, array and target MOCK:LARGE-FAIL');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(summary).toHaveText('0 of 2 large cases generated');
  await expect(summary).toHaveClass(/tone-warn/);
  await showAll();
  await expect(outcomes.getByText(/^Large case “.+” not added\. The generator crashed/)).toHaveCount(2);
  await expect(page.getByText('Too large to show or edit')).toHaveCount(0);
  await expect(largeCards).toHaveCount(0);
});

test('large test cases: asked for on the generate form, then kept and managed on the Test cases page', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  await page.getByRole('link', { name: /Generate/ }).first().click();

  // Off, as the preference is; on for this run, as many as the preference says.
  const large = page.getByRole('checkbox', { name: 'Add 3 large test cases' });
  await expect(large).not.toBeChecked();
  await large.check();
  await page.getByLabel('How many').fill('3');
  const outcomes = page.getByRole('region', { name: 'Large test cases' });
  const show = outcomes.getByRole('button', { name: 'Show large cases' });
  const proposed = page.locator('.proposal-case');
  const largeProposed = page.locator('.large-cases + .proposal-list .proposal-case');

  // A case the model wrote no generator for has a line of its own, there being no case to show.
  await page.getByLabel('Anything to focus on? (optional)').fill('MOCK:LARGE-SHORT');
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await expect(outcomes.getByRole('status')).toHaveText('2 of 3 large cases generated');
  await show.click();
  await expect(outcomes.getByRole('listitem')).toHaveText(['Large case not added. The model wrote fewer generators than asked for.']);
  await expect(largeProposed).toHaveCount(2);
  await page.getByLabel('Anything to focus on? (optional)').fill('');
  await page.getByRole('button', { name: 'Generate again' }).click();

  // The proposed cases, then the large ones summed up, which follow on request.
  await expect(page.getByText('6 of 6 selected')).toBeVisible();
  await expect(outcomes.getByRole('status')).toHaveText('3 large cases generated');
  await expect(outcomes.getByRole('button', { name: 'About large cases' })).toHaveCount(0);
  await expect(page.locator('.proposal-list + .large-cases')).toHaveCount(1);
  await expect(proposed).toHaveCount(3);
  await expect(largeProposed).toHaveCount(0);
  // Out of sight is not left out: they are counted, selected and saved.
  await page.getByRole('button', { name: 'Select none' }).click();
  await expect(page.getByText('0 of 6 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Select all' }).click();
  await expect(page.getByText('6 of 6 selected')).toBeVisible();
  await show.click();
  await expect(largeProposed).toHaveCount(3);
  await expect(proposed).toHaveCount(6);
  await expect(outcomes.getByRole('listitem')).toHaveCount(0);

  // Each opens on its generator, then its data, too large to show.
  const last = largeProposed.last();
  const generator = last.getByRole('textbox', { name: /^Generator of “.+”, Python/ });
  await expect(page.getByRole('textbox', { name: /^Generator of / })).toHaveCount(3);
  await expect(generator).toContainText('random.seed(');
  await expect(last.getByRole('button', { name: 'Download' })).toBeVisible();
  expect((await generator.boundingBox())!.y).toBeLessThan((await last.getByRole('button', { name: 'Download' }).boundingBox())!.y);
  await expectNoLargeText(page);
  await last.getByRole('checkbox', { name: /^Keep / }).uncheck();
  await outcomes.getByRole('button', { name: 'Hide large cases' }).click();
  await expect(largeProposed).toHaveCount(0);
  await expect(page.getByText('5 of 6 selected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save 5 cases' })).toBeVisible();
  await show.click();
  await largeProposed.last().getByRole('checkbox', { name: /^Keep / }).check();
  await page.getByRole('button', { name: 'Save 6 cases' }).click();

  // On the Test cases page they stay out of sight too; renaming, marking and moving still work.
  await expect(page).toHaveURL(/\/tests$/);
  await page.getByRole('button', { name: 'Show test cases' }).first().click();
  await expect(page.getByRole('button', { name: 'Hide test cases' })).toBeVisible();
  await page.locator('.case-row').last().locator('.case-row-main').click();
  const editor = page.getByRole('group', { name: 'Selected test case' });
  await expect(editor.getByRole('group', { name: 'Input (stdin)' })).toContainText(/Too large to show or edit · \d+\u00a0KB · \d+ lines?/);
  await expect(editor.getByRole('button', { name: 'Download' })).toBeVisible();
  await expectNoLargeText(page);
  await editor.getByLabel('Name').fill('Big input');
  await editor.getByRole('checkbox', { name: 'Sample' }).check();
  await editor.getByRole('button', { name: 'Save case' }).click();
  await expect(page.getByText('Test case saved')).toBeVisible();
  const row = page.locator('.case-row').filter({ hasText: 'Big input' });
  await expect(row.getByText('sample', { exact: true })).toBeVisible();
  // A saved sample has no Delete: it is part of the statement.
  await expect(editor.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(editor.getByText('Untick Sample to delete it')).toBeVisible();
  await row.getByRole('button', { name: 'Move Big input up' }).click();
  await expect(page.locator('.case-row').nth(-2)).toContainText('Big input');
  await expect(editor.getByText(/Too large to show or edit/)).toBeVisible();
});

test('verify all: a draft is checked again as edited, and a saved problem from the top of its test cases', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('radiogroup', { name: 'What you write' }).getByText('Full program').click();
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText('Passes 2 of 2 test cases')).toBeVisible();

  // Editing a case takes its mark away; "Verify all" runs the check again on the cases as they stand.
  const second = page.getByRole('listitem').filter({ has: page.getByRole('textbox', { name: 'Name of case 2' }) });
  await second.getByLabel('Expected output').fill('1 2 MOCK:WA');
  await expect(second.getByText('verified')).toHaveCount(0);
  await expect(page.getByText('Checked before your edits')).toBeVisible();
  await page.getByRole('button', { name: 'Verify all' }).click();
  const result = page.locator('section[aria-labelledby="cases-heading"]').getByRole('status').filter({ hasText: /^Passes/ });
  await expect(result).toHaveText(/^Passes 1 of 2 test cases\. Example 2: expected 1 2 MOCK:WA/);
  await expect(page.getByRole('listitem').filter({ has: page.getByRole('textbox', { name: 'Name of case 1' }) }).getByText('verified')).toBeVisible();
  await expect(second.getByText('wrong', { exact: true })).toBeVisible();

  // The case it found wrong goes in one step, and the check follows.
  await page.getByRole('button', { name: 'Discard 1 failed' }).click();
  await expect(page.getByRole('textbox', { name: 'Name of case 2' })).toHaveCount(0);
  await expect(result).toHaveText('Passes 1 of 1 test case');

  // Without a reference solution there is nothing to verify with, and the button says why.
  await page.getByRole('button', { name: 'Remove the reference solution' }).click();
  await expect(page.getByRole('button', { name: 'Verify all' })).toBeDisabled();
  await expect(page.getByText('Needs a reference solution')).toBeVisible();

  // On a saved problem it runs the reference solution, from the top of the Test cases page.
  await page.getByRole('link', { name: /^All items/ }).click();
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  await page.getByRole('button', { name: 'Verify all' }).click();
  await expect(page.getByText(/^All \d+ cases match the reference solution and are marked verified$/)).toBeVisible();
  // Another saved solution is a check, from the Verification card.
  await page.getByRole('button', { name: 'Check solution', exact: true }).click();
  await expect(page.getByText(/A check only: marks and expected outputs are unchanged\./)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Discard/ })).toHaveCount(0);

  // A case the reference solution does not reproduce can be deleted from the result.
  await page.getByRole('link', { name: /^All items/ }).click();
  await page.getByRole('link', { name: 'Merge Intervals', exact: true }).click();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  const rows = page.getByRole('list', { name: 'Test cases' }).getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await page.getByRole('button', { name: 'Verify all' }).click();
  await expect(page.getByText(/^\d+ of \d+ match · 1 differ · 0 failed to run$/)).toBeVisible();
  await page.getByRole('button', { name: 'Discard 1 failed' }).click();
  await page.getByRole('dialog', { name: 'Delete 1 test case?' }).getByRole('button', { name: 'Delete 1 test case' }).click();
  await expect(page.getByText('Deleted 1 test case')).toBeVisible();
  await expect(rows).toHaveCount(before - 1);
});

test('settings: each category is its own page, and a link to an old section still arrives', async ({ page }) => {
  // Settings used to be one page with `#judge`-style sections.
  await open(page, '/settings#judge');
  await expect(page).toHaveURL(/\/settings\/judge$/);
  await expect(page).toHaveTitle(/^Judge · Settings/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Judge');

  const nav = page.getByRole('navigation', { name: 'Settings' });
  await expect(nav.getByRole('link', { name: 'Judge' })).toHaveAttribute('aria-current', 'page');

  // The navigation changes the page, and only that category is shown.
  await nav.getByRole('link', { name: 'Writing styles' }).click();
  await expect(page).toHaveURL(/\/settings\/styles$/);
  await expect(page).toHaveTitle(/^Writing styles · Settings/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Writing styles');
  await expect(nav.getByRole('link', { name: 'Writing styles' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Judge' })).not.toHaveAttribute('aria-current');
  await expect(page.getByRole('heading', { name: 'Judge' })).toHaveCount(0);

  // The sidebar marks Settings on every one of its pages, and its entry opens the first.
  const settings = page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: 'Settings', exact: true });
  await expect(settings).toHaveAttribute('aria-current', 'page');
  await settings.click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI providers');
  await expect(settings).toHaveAttribute('aria-current', 'page');

  // Appearance is part of Preferences; its old address still arrives there.
  await expect(nav.getByRole('link', { name: 'Appearance' })).toHaveCount(0);
  await nav.getByRole('link', { name: 'Preferences' }).click();
  const appearance = page.getByRole('group', { name: 'Appearance' });
  await appearance.getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => window.history.pushState({}, '', '/settings/appearance'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await expect(page).toHaveURL(/\/settings\/preferences$/);
});

test('preferences: the reading text size scales rendered Markdown and is kept in this browser', async ({ page }) => {
  await open(page, '/settings/preferences');
  const appearance = page.getByRole('group', { name: 'Appearance' });
  await appearance.getByText('Large', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'large');

  const nav = page.getByRole('complementary', { name: 'Navigation' });
  await nav.getByRole('link', { name: /^Readings/ }).click();
  await page.locator('.item-title').first().click();
  const body = page.locator('.md-longform');
  await expect(body).toHaveCSS('font-size', '19.55px');

  // Kept across a reload, and Default puts the sizes back.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'large');
  await page.goto('/settings/preferences');
  await page.getByRole('group', { name: 'Appearance' }).getByText('Default', { exact: true }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-reading-size');
});

test('AI providers: Turn AI off and Turn AI on keep the default', async ({ page }) => {
  await open(page, '/settings/ai');
  const section = page.getByRole('region', { name: 'AI providers' });
  const nav = page.getByRole('complementary', { name: 'Navigation' });
  const turnOff = section.getByRole('button', { name: 'Turn AI off' });
  const turnOn = section.getByRole('button', { name: 'Turn AI on' });
  const personal = section.getByRole('listitem').filter({ hasText: 'Personal key' });
  await expect(section.getByText('On · Personal key · claude-opus-5-5')).toBeVisible();
  await expect(turnOn).toHaveCount(0);

  // Off: the default provider stays marked, and nothing tells the user to make one the default.
  await turnOff.click();
  await expect(turnOn).toBeVisible();
  await expect(turnOff).toHaveCount(0);
  await expect(section.locator('.ai-status')).toHaveText('Off');
  await expect(personal.getByText('default', { exact: true })).toBeVisible();
  await expect(nav.getByTitle('AI drafting is off')).toBeVisible();
  await expect(page.getByText(/no provider is the default|Make default” on one/)).toHaveCount(0);

  // Making another the default does not turn AI on; the default moves.
  const ollama = section.getByRole('listitem').filter({ hasText: 'Local Ollama' });
  await ollama.getByRole('button', { name: 'Make default' }).click();
  await expect(ollama.getByText('default', { exact: true })).toBeVisible();
  await expect(turnOn).toBeVisible();
  await personal.getByRole('button', { name: 'Make default' }).click();
  await expect(personal.getByText('default', { exact: true })).toBeVisible();

  // On again, with the same default.
  await turnOn.click();
  await expect(turnOff).toBeVisible();
  await expect(section.getByText('On · Personal key · claude-opus-5-5')).toBeVisible();
  await expect(nav.getByTitle('AI drafting: Personal key · claude-opus-5-5')).toBeVisible();

  // Deleting the default leaves none: AI is off, and turning it on picks the first ready provider.
  await personal.getByRole('button', { name: 'Delete Personal key' }).click();
  await page.getByRole('dialog', { name: 'Delete the provider “Personal key”?' }).getByRole('button', { name: 'Delete provider' }).click();
  await expect(personal).toHaveCount(0);
  await turnOn.click();
  await expect(section.getByText('On · Local Ollama · qwen2.5-coder:14b')).toBeVisible();
  await expect(ollama.getByText('default', { exact: true })).toBeVisible();
});

test('AI providers: Turn AI on picks a ready provider when there is no default, and is not offered with none', async ({ page }) => {
  // An environment provider, not in use.
  await open(page, '/settings/ai', 'fast,ai-env,no-ai');
  const section = page.getByRole('region', { name: 'AI providers' });
  const turnOn = section.getByRole('button', { name: 'Turn AI on' });
  await expect(section.locator('.ai-status')).toHaveText('Off');
  await turnOn.click();
  await expect(section.getByText('On · Anthropic (environment) · claude-opus-5-5')).toBeVisible();

  // No providers: nothing to turn on.
  await open(page, '/settings/ai', 'fast,no-ai');
  await expect(section.getByText('No providers yet')).toBeVisible();
  await expect(turnOn).toHaveCount(0);
});

test('AI providers: with a default that is not ready, AI is off with no Turn AI on, and the warning says what it needs', async ({ page }) => {
  // The seeded default loses its key before the app loads.
  await page.addInitScript(() => {
    type Mock = { db: { ai: { defaultProviderId: string | null; providers: { id: string; apiKey: string | null }[] } } };
    let mock: Mock | undefined;
    Object.defineProperty(window, '__codeatrophyMock', {
      configurable: true,
      get: () => mock,
      set: (m: Mock) => {
        mock = m;
        m.db.ai.providers.find((p) => p.id === m.db.ai.defaultProviderId)!.apiKey = null;
      },
    });
  });
  await open(page, '/settings/ai');
  const section = page.getByRole('region', { name: 'AI providers' });
  await expect(section.getByText('Off · Personal key is not ready')).toBeVisible();
  await expect(section.getByRole('button', { name: /^Turn AI (on|off)$/ })).toHaveCount(0);
  await expect(section.getByText('The default provider, “Personal key”, needs an API key. Complete it, or make another provider the default.')).toBeVisible();

  // Another default makes AI on again, as it was saved on.
  await section.getByRole('listitem').filter({ hasText: 'Local Ollama' }).getByRole('button', { name: 'Make default' }).click();
  await expect(section.getByRole('button', { name: 'Turn AI off' })).toBeVisible();
  await expect(section.getByText(/^The default provider, /)).toHaveCount(0);
});

test('AI providers: a new one gets a model from the loaded list, is added once tested, and becomes the default', async ({ page }) => {
  await open(page, '/settings/ai');
  const section = page.getByRole('region', { name: 'AI providers' });
  await expect(section.getByText('On · Personal key · claude-opus-5-5')).toBeVisible();

  // Each provider says when it was last used and links to its requests.
  const personal = section.getByRole('listitem').filter({ hasText: 'Personal key' });
  await expect(personal.getByText(/^Last used /)).toBeVisible();
  await expect(personal).not.toContainText(/\d+ requests/);
  await expect(personal.getByRole('link', { name: 'Requests through Personal key' })).toHaveAttribute('href', /\/settings\/ai-activity\?provider=/);
  await expect(section.getByRole('listitem').filter({ hasText: 'Work gateway' })).toContainText('Not used yet');

  await section.getByRole('button', { name: 'Add provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add provider' });
  const note = dialog.locator('.dialog-note');
  const add = dialog.getByRole('button', { name: 'Add provider' });
  const testButton = dialog.getByRole('button', { name: 'Test connection' });
  const listed = dialog.getByText(/^9 models from api\.openai\.com, loaded just now\.$/);
  await dialog.getByRole('radio', { name: /OpenAI-compatible/ }).check();
  await dialog.getByLabel('Name').fill('Work OpenAI');
  await dialog.getByLabel('API key').fill('sk-smoke-test-0000Zk9d');
  await expect(note).toHaveText('Pick a model, then test the connection.');
  // The key is masked without a password field, so browsers do not take the form for a login.
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(dialog.getByLabel('API key')).toHaveCSS('-webkit-text-security', 'disc');

  // An OpenAI-compatible provider has to name its server before anything is asked of it.
  const baseUrl = dialog.getByLabel('Base URL');
  await expect(baseUrl).toHaveValue('');
  await dialog.getByRole('button', { name: 'Refresh models' }).click();
  await expect(dialog.getByText('Enter the base URL.')).toBeVisible();
  await baseUrl.fill('https://api.openai.com/v1');

  // Refreshing loads the models the service offers and, with none set, leads to picking one.
  const model = dialog.getByRole('combobox', { name: 'Model' });
  await expect(model).toHaveValue('');
  await dialog.getByRole('button', { name: 'Refresh models' }).click();
  await expect(listed).toBeVisible();
  await expect(model).toBeFocused();
  await page.getByRole('option', { name: 'gpt-4.1', exact: true }).click();
  await expect(model).toHaveValue('gpt-4.1');

  // Not added before a test has passed.
  await expect(note).toHaveText('Test the connection to add it.');
  await expect(add).toBeDisabled();
  await testButton.click();
  await expect(dialog.getByText('The connection works')).toBeVisible();
  await expect(note).toHaveText('Tested. Ready to add.');
  await expect(add).toBeFocused();

  // Another model needs no new test; another key does.
  await model.fill('gpt-4.1-mini');
  await expect(note).toHaveText('Tested. Ready to add.');
  // A name the list does not have is put back to the last one on leaving the field, or on Enter.
  await model.fill('gpt-4.1-min');
  await dialog.getByLabel('Name').focus();
  await expect(model).toHaveValue('gpt-4.1-mini');
  await model.fill('gpt-4');
  await model.press('Enter');
  await expect(model).toHaveValue('gpt-4.1-mini');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('API key').fill('sk-smoke-other-Zk9d');
  await expect(note).toHaveText('Test the connection to add it.');
  await expect(add).toBeDisabled();
  await testButton.click();
  await expect(note).toHaveText('Tested. Ready to add.');

  // Another server has none of these models to offer and needs a test of its own; back on this one, the test still counts.
  await baseUrl.fill('http://localhost:11434/v1');
  await expect(dialog.getByText(/ models from /)).toHaveCount(0);
  await expect(note).toHaveText('Test the connection to add it.');
  await baseUrl.fill('https://api.openai.com/v1');
  await expect(dialog.getByText(/^9 models from api\.openai\.com, loaded /)).toBeVisible();
  await expect(note).toHaveText('Tested. Ready to add.');
  await add.click();
  await expect(dialog).toBeHidden();

  // It is listed as ready, with its key shown by the last four characters only; the default has not moved.
  const row = section.getByRole('listitem').filter({ hasText: 'Work OpenAI' });
  await expect(row).toContainText('gpt-4.1-mini');
  await expect(row).toContainText('key ending in Zk9d');
  await expect(row.getByText('ready', { exact: true })).toBeVisible();
  await expect(row).toContainText('Not used yet');
  await expect(section.getByText('On · Personal key · claude-opus-5-5')).toBeVisible();

  // Made the default, it is the one in use: on the page and in the sidebar.
  await row.getByRole('button', { name: 'Make default' }).click();
  await expect(section.getByText('On · Work OpenAI · gpt-4.1-mini')).toBeVisible();
  await expect(row.getByText('default', { exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Navigation' }).getByTitle('AI drafting: Work OpenAI · gpt-4.1-mini')).toBeVisible();

  // The models loaded are offered again when the provider is edited.
  await row.getByRole('button', { name: 'Edit Work OpenAI' }).click();
  const editing = page.getByRole('dialog', { name: 'Edit provider' });
  await expect(editing.getByText(/^9 models from api\.openai\.com, loaded /)).toBeVisible();
  await editing.getByRole('combobox', { name: 'Model' }).click();
  await expect(page.getByRole('option', { name: 'gpt-4.1-mini' })).toBeVisible();
});

test('AI providers: a Google Gemini one is added from its listed models, on Google\'s own server', async ({ page }) => {
  await open(page, '/settings/ai');
  const section = page.getByRole('region', { name: 'AI providers' });
  await section.getByRole('button', { name: 'Add provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add provider' });
  const note = dialog.locator('.dialog-note');
  await dialog.getByRole('radio', { name: /Google Gemini/ }).check();
  await expect(dialog.getByLabel('Name')).toHaveValue('Google Gemini');
  // It has a server of its own, so no base URL is asked for; nor is there a default model.
  await expect(dialog.getByText('Connects to generativelanguage.googleapis.com.')).toBeVisible();
  const model = dialog.getByRole('combobox', { name: 'Model' });
  await expect(model).toHaveAttribute('placeholder', 'e.g. gemini-3.5-flash…');

  await dialog.getByLabel('API key').fill('AIza-smoke-test-0000Gm1n');
  await dialog.getByRole('button', { name: 'Refresh models' }).click();
  await expect(dialog.getByText(/^7 models from generativelanguage\.googleapis\.com, loaded just now\.$/)).toBeVisible();
  await expect(model).toBeFocused();
  await expect(page.getByRole('option', { name: /embedding|^models\// })).toHaveCount(0);
  await page.getByRole('option', { name: 'gemini-3.5-flash', exact: true }).click();
  await expect(note).toHaveText('Test the connection to add it.');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText('The connection works')).toBeVisible();
  await expect(note).toHaveText('Tested. Ready to add.');
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  await expect(dialog).toBeHidden();

  const row = section.getByRole('listitem').filter({ hasText: 'Google Gemini' });
  await expect(row).toContainText('gemini-3.5-flash');
  await expect(row).toContainText('key ending in Gm1n');
  await expect(row.getByText('ready', { exact: true })).toBeVisible();
});

test('AI providers: editing one offers its models without a test, and asks for a test only for a new server or key', async ({ page }) => {
  await open(page, '/settings/ai');
  const section = page.getByRole('region', { name: 'AI providers' });
  const gateway = section.getByRole('listitem').filter({ hasText: 'Work gateway' });
  const editing = page.getByRole('dialog', { name: 'Edit provider' });
  const note = editing.locator('.dialog-note');
  const model = editing.getByRole('combobox', { name: 'Model' });
  const baseUrl = editing.getByLabel('Base URL');
  const save = editing.getByRole('button', { name: 'Save provider' });
  const testButton = editing.getByRole('button', { name: 'Test connection' });
  const listed = editing.getByText(/^6 models from llm\.example\.org, loaded just now\.$/);

  // Nothing remembered for its server: the list is loaded as the dialog opens, without a test, and another model saves as it is.
  await gateway.getByRole('button', { name: 'Edit Work gateway' }).click();
  await expect(listed).toBeVisible();
  await editing.getByRole('button', { name: 'Show models' }).click();
  await page.getByRole('option', { name: 'llama3.1:8b' }).click();
  await expect(editing.getByText('The connection works')).toBeHidden();
  await save.click();
  await expect(editing).toBeHidden();
  await expect(gateway).toContainText('llama3.1:8b');

  // Another server blanks the list and asks for a test; put back, its list is there again and it saves untested.
  await gateway.getByRole('button', { name: 'Edit Work gateway' }).click();
  await expect(listed).toBeVisible();
  await baseUrl.fill('https://gpu.example.org/v1');
  await expect(editing.getByText(/ models from /)).toHaveCount(0);
  await expect(note).toHaveText('Test the connection to save it.');
  await baseUrl.fill('https://llm.example.org/v1/');
  await expect(listed).toBeVisible();
  await expect(note).toHaveText('');
  await save.click();
  await expect(editing).toBeHidden();

  // A new key is saved once a test of it has passed.
  await gateway.getByRole('button', { name: 'Edit Work gateway' }).click();
  await editing.getByLabel('API key').fill('sk-gateway-new-0000Wq3e');
  await expect(note).toHaveText('Test the connection to save it.');
  await expect(save).toBeDisabled();
  await testButton.click();
  await expect(note).toHaveText('Tested. Save to keep it.');
  await save.click();
  await expect(editing).toBeHidden();
  await expect(gateway).toContainText('key ending in Wq3e');

  // A server that does not list its models says so; a name typed by hand is tested and saved.
  await gateway.getByRole('button', { name: 'Edit Work gateway' }).click();
  await baseUrl.fill('http://no-models.lan:8000/v1');
  await editing.getByRole('button', { name: 'Refresh models' }).click();
  await expect(editing.getByText('The models could not be loaded: no-models.lan:8000 does not list its models (404 Not Found for /models).')).toBeVisible();
  await model.fill('my-finetune');
  await expect(save).toBeDisabled();
  await testButton.click();
  await expect(editing.getByText('The connection works')).toBeVisible();
  await save.click();
  await expect(editing).toBeHidden();
  await expect(gateway).toContainText('my-finetune');

  // A remembered list shows straight away, and Refresh models replaces it.
  await page.evaluate(() => {
    const at = new Date(Date.now() - 3 * 86_400_000).toISOString();
    localStorage.setItem('codeatrophy:ai-models', JSON.stringify({ 'openai_compatible http://localhost:11434/v1': { models: ['stale-model'], at } }));
  });
  await section.getByRole('button', { name: 'Edit Local Ollama' }).click();
  await expect(editing.getByText('1 model from localhost:11434, loaded 3 days ago.')).toBeVisible();
  await editing.getByRole('button', { name: 'Refresh models' }).click();
  await expect(editing.getByText(/^6 models from localhost:11434, loaded just now\.$/)).toBeVisible();
  await editing.getByRole('button', { name: 'Show models' }).click();
  await expect(page.getByRole('option', { name: 'qwen2.5-coder:14b' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'stale-model' })).toHaveCount(0);
});

test('AI providers: an effort level is picked and saved, shown in the list, and tested where the test sends it', async ({ page }) => {
  await open(page, '/settings/ai');
  const section = page.getByRole('region', { name: 'AI providers' });
  const editing = page.getByRole('dialog', { name: 'Edit provider' });
  const note = editing.locator('.dialog-note');
  const effort = editing.getByRole('combobox', { name: 'Effort level' });
  const save = editing.getByRole('button', { name: 'Save provider' });

  // Anthropic's is saved as it is: its test asks for low whatever is set.
  const personal = section.getByRole('listitem').filter({ hasText: 'Personal key' });
  await expect(personal).toContainText('high effort');
  await personal.getByRole('button', { name: 'Edit Personal key' }).click();
  await expect(effort).toHaveText('High');
  const list = await openList(effort);
  await expect(list.getByRole('option')).toHaveText(['Default', 'Low', 'Medium', 'High']);
  await list.getByRole('option', { name: 'Medium', exact: true }).click();
  await expect(effort).toHaveText('Medium');
  await expect(note).toHaveText('');
  await save.click();
  await expect(editing).toBeHidden();
  await expect(personal).toContainText('medium effort');
  await expect(personal).not.toContainText('high effort');

  // Back to the model's default, nothing is shown.
  await personal.getByRole('button', { name: 'Edit Personal key' }).click();
  await choose(effort, 'Default');
  await save.click();
  await expect(editing).toBeHidden();
  await expect(personal).not.toContainText('effort');

  // An OpenAI-compatible provider sends the level on its test, so another one is saved once tested.
  const ollama = section.getByRole('listitem').filter({ hasText: 'Local Ollama' });
  await expect(ollama).not.toContainText('effort');
  await ollama.getByRole('button', { name: 'Edit Local Ollama' }).click();
  await expect(effort).toHaveText('Default');
  await choose(effort, 'Low');
  await expect(note).toHaveText('Test the connection to save it.');
  await expect(save).toBeDisabled();
  await editing.getByRole('button', { name: 'Test connection' }).click();
  await expect(note).toHaveText('Tested. Save to keep it.');
  await choose(effort, 'High');
  await expect(note).toHaveText('Test the connection to save it.');
  await choose(effort, 'Low');
  await expect(note).toHaveText('Tested. Save to keep it.');
  await save.click();
  await expect(editing).toBeHidden();
  await expect(ollama).toContainText('low effort');
});

test('AI providers: the request timeout is saved when committed, and a value out of range is not sent', async ({ page }) => {
  await open(page, '/settings/ai');
  const section = page.getByRole('region', { name: 'AI providers' });
  const timeout = section.getByLabel('Request timeout');
  // What the server holds. A reload would reset the mock, so it is asked directly.
  const saved = () =>
    page.evaluate(async () => {
      const mock = (window as unknown as { __codeatrophyMock: { fetch: (url: string) => Promise<Response> } }).__codeatrophyMock;
      return ((await (await mock.fetch('/api/v1/settings/ai')).json()) as { timeoutSeconds: number }).timeoutSeconds;
    });

  await expect(timeout).toHaveValue('300');
  await expect(timeout).toHaveAccessibleDescription('seconds');
  await timeout.fill('120');
  expect(await saved()).toBe(300);
  await timeout.press('Enter');
  await expect.poll(saved).toBe(120);
  await expect(section.locator('.ai-timeout-card').getByRole('status')).toHaveText('Saved');

  // Still there after leaving the page and coming back.
  const nav = page.getByRole('navigation', { name: 'Settings' });
  await nav.getByRole('link', { name: 'Preferences' }).click();
  await expect(timeout).toBeHidden();
  await nav.getByRole('link', { name: 'AI providers' }).click();
  await expect(timeout).toHaveValue('120');

  // Out of range: the field says why and keeps what was typed, and nothing is saved.
  await timeout.fill('5');
  await timeout.blur();
  await expect(section.getByRole('alert')).toHaveText('Between 10 and 300.');
  await expect(timeout).toHaveValue('5');
  await expect(timeout).toHaveAttribute('aria-invalid', 'true');
  expect(await saved()).toBe(120);
});

test('model: a draft, its revision and generated test cases use the provider chosen for them, and the default stays', async ({ page }) => {
  await open(page, '/new');
  const model = page.getByRole('combobox', { name: 'Model' });
  await expect((await openList(model)).getByRole('option')).toHaveText(['Personal key · claude-opus-5-5 (default)', 'Local Ollama · qwen2.5-coder:14b', 'Work gateway · llama3.1:70b']);
  await page.keyboard.press('Escape');
  await expect(model).toHaveText('Personal key · claude-opus-5-5 (default)');
  await choose(model, 'Local Ollama · qwen2.5-coder:14b');

  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it.');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  await expect(page.locator('.usage-line')).toContainText('qwen2.5-coder:14b');

  // The revision form, once unfolded, carries the choice on, and can change it.
  await page.getByRole('button', { name: 'Ask for a revision' }).click();
  const revise = page.locator('.revise-form').getByRole('combobox', { name: 'Model' });
  await expect(revise).toHaveText('Local Ollama · qwen2.5-coder:14b');
  await choose(revise, 'Work gateway · llama3.1:70b');
  await page.getByLabel('What to change').fill('use 1-based indices');
  await page.getByRole('button', { name: 'Revise draft' }).click();
  await expect(page.getByText('Revising the draft…')).toBeHidden();
  await expect(page.locator('.usage-line')).toContainText('llama3.1:70b');

  // Choosing did not move the default.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AI providers' }).getByText('On · Personal key · claude-opus-5-5')).toBeVisible();

  // The Generate test cases page has its own choice, which starts on the default.
  await page.getByRole('link', { name: /^All items/ }).click();
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  await page.getByRole('link', { name: /Generate/ }).first().click();
  await expect(model).toHaveText('Personal key · claude-opus-5-5 (default)');
  await choose(model, 'Work gateway · llama3.1:70b');
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await expect(page.locator('.proposal-head .usage-line')).toContainText('llama3.1:70b');
});

test('model: there is no picker with only one provider ready', async ({ page }) => {
  // The environment's provider is the only one.
  await open(page, '/settings/ai?mock=ai-env,fast');
  await expect(page.getByRole('region', { name: 'AI providers' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('link', { name: 'New item' }).click();
  await expect(page.getByRole('button', { name: 'Draft with AI' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Style' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
});

test('AI activity: a generation is logged with its raw request, and the list loads as it is scrolled', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();

  // What the generation cost leads to its entry, which arrives opened.
  await page.locator('.usage-line').click();
  await expect(page).toHaveURL(/\/settings\/ai-activity\?entry=/);
  const rows = page.getByRole('list', { name: 'Requests' }).getByRole('listitem');
  const newest = rows.first();
  await expect(newest.locator('.log-row')).toHaveAttribute('aria-expanded', 'true');
  // The key figures are on the row itself.
  await expect(newest.locator('.log-row')).toContainText(/Draft · Two Sum.*Personal key.*claude-opus-5-5.*[\d.]+k.*\d+.*\d+\u00a0s.*just now/);
  await expect(newest.getByRole('textbox', { name: 'Request' })).toContainText('two sum — array of ints and a target');
  await expect(newest.getByRole('textbox', { name: 'Response' })).toContainText('"title": "Two Sum"');
  await newest.locator('.log-row').click();
  await expect(newest.getByRole('textbox')).toHaveCount(0);

  // The rest of the log arrives as its end comes into view.
  await expect(rows).toHaveCount(50);
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(100);

  // Filters are the server's.
  await choose(page.getByRole('combobox', { name: 'Outcome' }), 'Failed');
  await expect(rows.first()).toContainText('failed');
  await rows.first().locator('.log-row').click();
  await expect(rows.first().getByText('No response arrived.')).toBeVisible();
});

test('output comparison: the two choices are explained behind the "i" of the field', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit details…' }).click();
  const choice = page.getByRole('combobox', { name: 'Output comparison', exact: true });
  await expect((await openList(choice)).getByRole('option')).toHaveText(['Values only', 'Exact text']);
  await page.keyboard.press('Escape');

  const tip = page.getByRole('button', { name: 'About output comparison' });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await tip.focus();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Values only: spacing and line breaks are ignored.');
  await expect(tooltip).toContainText('Exact text: spacing and line breaks must match.');
  // Clear of the control it explains, and Escape puts it away without leaving the page.
  const [tipBox, choiceBox] = [await tooltip.boundingBox(), await choice.boundingBox()];
  expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(choiceBox!.y);
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await expect(choice).toBeVisible();
});

test('variants: a problem lists them in a tab of their own, with the offer of another', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  // Not under the statement any more.
  await expect(page.getByRole('link', { name: 'Two Sum in a Sorted Ledger' })).toHaveCount(0);
  await page.getByRole('tab', { name: /^Variants\s*2$/ }).click();
  await expect(page).toHaveURL(/[?&]tab=variants/);
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('link', { name: 'Two Sum in a Sorted Ledger' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Practise a variant' })).toBeVisible();

  // A direction leads to the variant page with that choice made.
  await panel.getByRole('link', { name: /^Harder/ }).click();
  await expect(page).toHaveURL(/\/variant\?mode=harder/);
  await expect(page.getByRole('radio', { name: /^Harder/ })).toBeChecked();
});

test('organise: selected items are filed into a new collection', async ({ page }) => {
  await open(page, '/');

  await page.getByRole('checkbox', { name: 'Select Coin Change' }).check();
  await page.getByRole('checkbox', { name: 'Select Edit Distance' }).check();
  const bulk = page.getByRole('toolbar', { name: 'Actions for selected items' });
  await expect(bulk).toContainText('2 selected');

  await bulk.getByRole('button', { name: 'Add to collection' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /New collection/ }).click();
  const create = page.getByRole('dialog', { name: /collection/i }).last();
  await create.getByLabel('Name').fill('Smoke test picks');
  await create.getByRole('button', { name: 'Create collection' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Add/ }).click();

  // The collection appears in the sidebar and holds exactly those two items.
  await page.getByRole('navigation').getByRole('link', { name: /Smoke test picks/ }).click();
  await expect(page.getByRole('heading', { name: /Smoke test picks/ })).toContainText('2');
  await expect(page.getByRole('link', { name: 'Coin Change' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit Distance' })).toBeVisible();
});

test('library: the filter box names the view, a row shows only a failed verdict and a cut title in full on hover, and the sidebar counts every view', async ({ page }) => {
  await open(page, '/');
  const nav = page.getByRole('complementary', { name: 'Navigation' });
  const filter = page.getByRole('search', { name: 'Filter items' }).getByRole('searchbox');
  await expect(filter).toHaveAttribute('placeholder', 'Filter items…');
  await expect(filter).toHaveAccessibleName('Filter items');

  // A verdict only when the last one failed. The status icon's tooltip gives any last one.
  const rows = page.locator('.item-row');
  const lru = rows.filter({ has: page.getByRole('link', { name: 'LRU Cache', exact: true }) });
  await expect(lru.locator('.item-verdict')).toHaveText('Compile error');
  await expect(lru.locator('.item-status button')).toHaveAttribute('title', 'To do · Last verdict: Compile error');
  await expect(page.locator('.item-verdict', { hasText: /Accepted|Executed/ })).toHaveCount(0);
  // A reading's type icon says what it is; its difficulty shows like a problem's, when it has one.
  const reading = rows.filter({ has: page.getByRole('link', { name: 'How B-Trees Work', exact: true }) });
  await expect(reading.getByLabel('Reading', { exact: true })).toBeVisible();
  await expect(reading.locator('.item-kind')).toHaveText('');
  const rated = rows.filter({ has: page.getByRole('link', { name: 'Raft: Leader Election Cheat Sheet', exact: true }) });
  await expect(rated.locator('.item-kind .badge-difficulty')).toHaveText('Medium');
  await expect(rows.locator('.item-kind, .item-verdict').filter({ hasText: 'Reading' })).toHaveCount(0);
  await expect(rows.locator('.badge').filter({ hasText: /^Reading$/ })).toHaveCount(0);

  // A title cut off by the row shows in full on hover; one that fits gets no tooltip.
  await page.setViewportSize({ width: 1000, height: 900 });
  const cut = rows.locator('.item-title', { hasText: 'Longest Substring Without Repeating Characters' });
  await cut.hover();
  await expect(cut).toHaveAttribute('title', 'Longest Substring Without Repeating Characters');
  const fits = rows.locator('.item-title', { hasText: 'LRU Cache' });
  await fits.hover();
  await expect(fits).not.toHaveAttribute('title', /./);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Favorites is counted like the other views, and follows changes. Uncollected is not in the sidebar for now.
  const count = (name: string) => nav.getByRole('link', { name: new RegExp(`^${name}`) }).locator('.nav-count');
  await expect(count('Favorites')).toHaveText('5');
  await lru.getByRole('button', { name: /favorite/i }).click();
  await expect(count('Favorites')).toHaveText('6');

  await nav.getByRole('link', { name: /^Problems/ }).click();
  await expect(filter).toHaveAttribute('placeholder', 'Filter problems…');
  await expect(filter).toHaveAccessibleName('Filter problems');
  await nav.getByRole('link', { name: /^Readings/ }).click();
  await expect(filter).toHaveAttribute('placeholder', 'Filter readings…');
  await nav.getByRole('link', { name: /^Favorites/ }).click();
  await expect(rows).toHaveCount(6);
  await expect(filter).toHaveAttribute('placeholder', 'Filter items…');
  await expect(nav.getByRole('link', { name: /^Uncollected/ })).toHaveCount(0);
});

test('settings: Import and Export are pages of Settings, and their old addresses lead there', async ({ page }) => {
  await open(page, '/');
  const sidebar = page.getByRole('complementary', { name: 'Navigation' });
  await expect(sidebar.getByRole('link', { name: 'Import', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: 'Export', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Actions for Interview prep' }).click();
  await page.getByRole('menuitem', { name: 'Export…' }).click();
  await expect(page).toHaveURL(/\/settings\/export\?collection=/);
  const collection = new URL(page.url()).searchParams.get('collection')!;
  const nav = page.getByRole('navigation', { name: 'Settings' });
  await expect(nav.getByRole('link', { name: 'Export' })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle(/^Export · Settings/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Export a bundle');
  await expect(page.getByLabel('Collection', { exact: true })).toHaveAttribute('value', collection);

  await nav.getByRole('link', { name: 'Import' }).click();
  await expect(page).toHaveURL(/\/settings\/import$/);
  await expect(nav.getByRole('link', { name: 'Import' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Import a bundle');

  // A bookmark of the old page arrives, with what it asked to export.
  await open(page, `/export?collection=${collection}&solutions=0`);
  await expect(page).toHaveURL(new RegExp(`/settings/export\\?collection=${collection}&solutions=0`));
  await expect(page.getByLabel('Collection', { exact: true })).toHaveAttribute('value', collection);
  await expect(page.getByRole('checkbox', { name: 'Saved solutions' })).not.toBeChecked();
  await open(page, '/import');
  await expect(page).toHaveURL(/\/settings\/import\?mock=fast$/);
});

test('item bar: the favorite button says what it does, and the menu keeps only edit, export and delete', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  const bar = page.locator('.itembar');
  const favorite = bar.getByRole('button', { name: 'Favorite', exact: true });
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');
  await favorite.click();
  const add = bar.getByRole('button', { name: 'Add to favorites', exact: true });
  await expect(add).toHaveAttribute('aria-pressed', 'false');
  await add.click();
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');

  await bar.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Edit details…', 'Export this item…', 'Delete']);
});

test('large test cases: a draft kept from before cases carried their generators still shows them', async ({ page }) => {
  await open(page, '/settings/preferences');
  await page.getByRole('checkbox', { name: 'Generate large test cases by default' }).check();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: /New item/ }).click();
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();

  // The kept draft's cases lose their generators; the generation's reports still have them.
  await expect.poll(() => page.evaluate(() => (localStorage.getItem('codeatrophy:capture:new') ?? '').includes('"generator"'))).toBe(true);
  await page.evaluate(() => {
    const key = 'codeatrophy:capture:new';
    const kept: unknown = JSON.parse(localStorage.getItem(key)!);
    const strip = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(strip);
      else if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>;
        if (r.large) delete r.generator;
        Object.values(r).forEach(strip);
      }
    };
    strip(kept);
    localStorage.setItem(key, JSON.stringify(kept));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Show large cases' }).click();
  await expect(page.getByRole('textbox', { name: /^Generator of case \d+, Python/ })).toHaveCount(3);
});
