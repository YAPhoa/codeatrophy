import { expect, test, type Page } from '@playwright/test';

// A short smoke suite over the flows the product stands on. It runs
// against the API mock, whose state lives in the page: every test starts from
// the seed library, and navigation inside a test must stay client-side (a
// reload would reset the mock).

/** Open the app with short mock delays, and fail the test on any page error or third-party request. */
async function open(page: Page, path: string): Promise<void> {
  page.on('pageerror', (error) => {
    throw error;
  });
  page.on('request', (request) => {
    const { hostname } = new URL(request.url());
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') throw new Error(`request to a third-party origin: ${request.url()}`);
  });
  const [route = '', hash] = path.split('#');
  await page.goto(`${route}${route.includes('?') ? '&' : '?'}mock=fast${hash ? `#${hash}` : ''}`);
}

test('capture: rough text becomes a reviewed, saved problem', async ({ page }) => {
  await open(page, '/new');

  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('button', { name: 'Draft with AI' }).click();

  // Review: the draft is complete, says what was assumed, and nothing is saved yet.
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  await expect(page.getByLabel('Title')).not.toHaveValue('');
  await expect(page.getByRole('region', { name: /assum|filled in/i })).toBeVisible();

  // A revision reworks the draft in place.
  await page.getByLabel('Ask for a revision').fill('use 1-based indices');
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
  await expect(page.locator('.usage-line')).toHaveText(/^claude-opus-5-5 · [\d.]+k in · \d+ out · \d+ s$/);

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
  const languages = page.getByRole('combobox', { name: 'Language' }).locator('option');
  // The default style keeps Python and Go, each with its runner.
  await expect(languages).toHaveCount(2);
  await expect(languages).toContainText(['Go', 'Python']);

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
  await page.getByRole('combobox', { name: 'Language' }).selectOption('cpp');
  await expect(editor.locator('.cm-line').filter({ hasText: '// region input' })).toBeVisible();
  await expect(editor.getByText('cin >> rows')).toHaveCount(0);
});

test('test cases to generate: the preference is where the generate page starts', async ({ page }) => {
  await open(page, '/settings/preferences');

  await expect(page.getByLabel('Test cases to generate')).toHaveValue('8');
  await page.getByRole('button', { name: 'More test cases' }).click();
  await page.getByLabel('Test cases to generate').fill('12');
  await page.getByLabel('Test cases to generate').blur();

  await page.getByRole('link', { name: /^All items/ }).click();
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  await page.getByRole('link', { name: /Generate/ }).first().click();
  await expect(page.getByLabel('How many')).toHaveValue('12');

  // It can still be changed for one run.
  await page.getByRole('button', { name: 'Fewer test cases' }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
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
  await page.getByRole('main').getByRole('link', { name: 'New item' }).click();
  await expect(kind.getByRole('radio', { name: 'Reading' })).toBeChecked();
  await expect(page).not.toHaveURL(/type=/);

  // From the problems, a problem — by any of the ways in.
  await nav.getByRole('link', { name: /Problems/ }).click();
  await nav.getByRole('link', { name: /New item/ }).click();
  await expect(kind.getByRole('radio', { name: 'Problem' })).toBeChecked();

  // From the unfiltered library the last choice is left alone.
  await kind.getByText('Auto-detect').click();
  await nav.getByRole('link', { name: 'All items' }).click();
  await page.getByRole('main').getByRole('link', { name: 'New item' }).click();
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
  await expect(result).toContainText(/Ran \d+ test cases — \d+ passed/);

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
  const editorLine = page.locator('.editor-host .cm-line').first();
  await expect(editorLine).toHaveCSS('font-size', '14px');

  await page.getByRole('button', { name: /^Expand navigation/ }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
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

test('large test case: the preference asks for one with every draft, kept out of sight', async ({ page }) => {
  await open(page, '/settings/preferences');
  const preference = page.getByRole('checkbox', { name: 'Generate a large test case by default' });
  await expect(preference).not.toBeChecked();
  await preference.check();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: /New item/ }).click();
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();

  // One line says what was added; the input itself is not shown, but can be downloaded.
  await expect(page.getByText(/^Large case “.+” added · \d+ KB · reference solution \d+ ms of \d+ s$/)).toBeVisible();
  const card = page.getByRole('listitem').filter({ hasText: 'Too large to show or edit' });
  await expect(card).toHaveCount(1);
  await expect(card.getByText('large', { exact: true })).toBeVisible();
  await expect(card.getByRole('group', { name: 'Input (stdin)' })).toContainText(/Too large to show or edit · \d+ KB · \d+ lines?/);
  await expect(card.getByText('30000')).toHaveCount(0);
  // Still renamed and marked like any case: the name and the expected output are the only fields.
  await expect(card.getByRole('textbox')).toHaveCount(2);
  await expectNoLargeText(page);
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toMatch(/-input\.txt$/);

  // The generator is there on request, read-only.
  const toggle = page.getByRole('button', { name: 'Show generator' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('random.seed')).toHaveCount(0);
  await toggle.click();
  await expect(page.getByRole('textbox', { name: /^Generator of the large case/ })).toContainText('random.seed(');

  // A revision asks again, and the case comes back.
  await page.getByLabel('Ask for a revision').fill('use 1-based indices');
  await page.getByRole('button', { name: 'Revise draft' }).click();
  await expect(page.getByText('Revising the draft…')).toBeHidden();
  await expect(page.getByText(/^Large case “.+” added/)).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Too large to show or edit' })).toHaveCount(1);

  // A large case that could not be built is reported, and nothing is added.
  await page.getByRole('button', { name: 'Back to input' }).click();
  await page.getByLabel('What you have').fill('two sum, array and target MOCK:LARGE-FAIL');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText(/^Large case not added\. The generator crashed/)).toBeVisible();
  await expect(page.getByText('Too large to show or edit')).toHaveCount(0);
});

test('large test case: asked for on the generate form, then kept and managed on the Test cases page', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  await page.getByRole('link', { name: /Generate/ }).first().click();

  // Off, as the preference is; on for this run.
  const large = page.getByRole('checkbox', { name: 'Add a large test case' });
  await expect(large).not.toBeChecked();
  await large.check();
  await page.getByLabel('How many').fill('3');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('4 of 4 selected')).toBeVisible();
  await expect(page.getByText(/^Large case “.+” added · \d+ KB · reference solution \d+ ms of 2 s$/)).toBeVisible();

  const proposed = page.locator('.proposal-case').last();
  await expect(proposed.getByText('large', { exact: true })).toBeVisible();
  await proposed.locator('.proposal-main').click();
  await expect(proposed.getByRole('button', { name: 'Download' })).toBeVisible();
  await expectNoLargeText(page);
  await page.getByRole('button', { name: 'Save 4 cases' }).click();

  // On the Test cases page it stays out of sight too; renaming, marking and moving still work.
  await expect(page).toHaveURL(/\/tests$/);
  await page.getByRole('button', { name: 'Show test cases' }).first().click();
  await page.locator('.case-row').last().locator('.case-row-main').click();
  const editor = page.getByRole('group', { name: 'Selected test case' });
  await expect(editor.getByRole('group', { name: 'Input (stdin)' })).toContainText(/Too large to show or edit · \d+ KB · \d+ lines?/);
  await expect(editor.getByRole('button', { name: 'Download' })).toBeVisible();
  await expectNoLargeText(page);
  await editor.getByLabel('Name').fill('Big input');
  await editor.getByRole('checkbox', { name: 'Sample' }).check();
  await editor.getByRole('button', { name: 'Save case' }).click();
  await expect(page.getByText('Test case saved')).toBeVisible();
  const row = page.locator('.case-row').filter({ hasText: 'Big input' });
  await expect(row.getByText('sample', { exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Check', exact: true }).click();
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
  await page.getByRole('dialog', { name: 'Delete 1 test case?' }).getByRole('button', { name: 'Delete' }).click();
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

test('AI providers: a new one is tested, gets a model from the loaded list, and becomes the default', async ({ page }) => {
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
  await dialog.getByRole('radio', { name: /OpenAI-compatible/ }).check();
  await dialog.getByLabel('Name').fill('Work OpenAI');
  await dialog.getByLabel('API key').fill('sk-smoke-test-0000Zk9d');

  // Testing the connection loads the models the service offers and, with none set, asks for one.
  const model = dialog.getByRole('combobox', { name: 'Model' });
  await expect(model).toHaveValue('');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText('The connection works')).toBeVisible();
  await expect(model).toBeFocused();
  await page.getByRole('option', { name: 'gpt-4.1-mini' }).click();
  await expect(model).toHaveValue('gpt-4.1-mini');

  await dialog.getByRole('button', { name: 'Add provider' }).click();
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
  await expect(newest.locator('.log-row')).toContainText(/Draft · Two Sum.*Personal key.*claude-opus-5-5.*[\d.]+k.*\d+.*\d+ s.*just now/);
  await expect(newest.getByRole('textbox', { name: 'Request' })).toContainText('two sum — array of ints and a target');
  await expect(newest.getByRole('textbox', { name: 'Response' })).toContainText('"title": "Two Sum"');
  await newest.locator('.log-row').click();
  await expect(newest.getByRole('textbox')).toHaveCount(0);

  // The rest of the log arrives as its end comes into view.
  await expect(page.getByText('247 requests')).toBeVisible();
  await expect(rows).toHaveCount(50);
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(100);

  // Filters are the server's: the count is of what matches.
  await page.getByLabel('Outcome').selectOption('failed');
  await expect(page.getByText('247 requests')).toHaveCount(0);
  await expect(rows.first()).toContainText('failed');
  await rows.first().locator('.log-row').click();
  await expect(rows.first().getByText('No response arrived.')).toBeVisible();
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
  await create.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Add/ }).click();

  // The collection appears in the sidebar and holds exactly those two items.
  await page.getByRole('navigation').getByRole('link', { name: /Smoke test picks/ }).click();
  await expect(page.getByRole('heading', { name: /Smoke test picks/ })).toContainText('2');
  await expect(page.getByRole('link', { name: 'Coin Change' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit Distance' })).toBeVisible();
});
