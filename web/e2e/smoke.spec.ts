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
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}mock=fast`);
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

/** Replace the code in the solving editor. */
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

  // Keeping the code is offered next to the verdict.
  await result.getByRole('button', { name: 'Save as solution' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as a solution' });
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
  await expect(page.getByLabel('Verify against')).toContainText('Smoke test solution');
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
