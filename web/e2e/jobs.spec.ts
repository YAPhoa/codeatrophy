import { expect, test, type Page } from '@playwright/test';
import { mockApi, open, SEED, TWO_SUM_TEXT } from './support';

// AI generations run as jobs on the server: leaving a screen never stops
// one, the AI jobs in the sidebar's footer follow them, and new items in
// progress are drafts on the server, listed under Drafts. With `?mock=default`
// a generation takes a few seconds, time enough to leave its screen first.

const TWO_SUM = SEED.twoSum;
const COIN_CHANGE = SEED.coinChange;

const jobsWindow = (page: Page) => page.getByRole('region', { name: 'AI jobs' });
/** The footer's jobs entry, named for what it counts ("AI jobs: 1 running"). */
const jobsEntry = (page: Page) => page.getByRole('complementary', { name: 'Navigation' }).getByRole('button', { name: /^AI jobs/ });
/** Opens the list from the footer, unless it is open already. */
async function openJobs(page: Page) {
  if ((await jobsWindow(page).count()) === 0) await jobsEntry(page).click();
  await expect(jobsWindow(page)).toBeVisible();
}
const drafts = (page: Page) => page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: /^Drafts/ });

test('jobs: a capture drafts on after its page is left, shows in the footer and under Drafts, and is reviewed on return', async ({ page }) => {
  await open(page, '/new', 'default');
  await expect(drafts(page)).toHaveText('Drafts');
  // Nothing in the footer until there is a job.
  await expect(jobsEntry(page)).toHaveCount(0);
  await page.getByLabel('What you have').fill(TWO_SUM_TEXT);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText('Drafting…')).toBeVisible();
  await expect(page).toHaveURL(/\/drafts\/[^/]+$/);

  // Elsewhere: the footer says it runs, and the sidebar counts the draft.
  await page.getByRole('link', { name: /^All items/ }).click();
  await expect(jobsEntry(page)).toHaveAccessibleName('AI jobs: 1 running');
  await expect(jobsEntry(page)).toHaveText('1 running');
  await expect(drafts(page)).toHaveText('Drafts1');

  // Done while the user is elsewhere: the list opens to say so, leaving focus where it was, and it is announced.
  const row = jobsWindow(page).getByRole('listitem');
  await expect(row).toContainText('Two Sum', { timeout: 10_000 });
  await expect(row).toContainText('Draft · Ready');
  await expect(jobsWindow(page)).not.toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: /^Draft “.+”: ready$/ })).toBeAttached();
  await expect(jobsEntry(page)).toHaveAccessibleName('AI jobs: 1 done');
  await expect(jobsEntry(page)).toHaveText('1 done');

  await drafts(page).click();
  const listed = page.getByRole('list', { name: 'Drafts' }).getByRole('listitem');
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText('Two Sum');
  await expect(listed).toContainText('Ready to review');

  // Clicking outside closed the list; the footer opens it again, and the row leads to the draft.
  await expect(jobsWindow(page)).toHaveCount(0);
  await openJobs(page);
  await jobsWindow(page).getByRole('link', { name: /Two Sum/ }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum');
  // Taken in, the job leaves the footer.
  await expect(jobsWindow(page)).toHaveCount(0);
  await expect(jobsEntry(page)).toHaveCount(0);
});

test('jobs: a draft keeps its edits through a reload, and saving it to the library takes it off the Drafts count', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill(TWO_SUM_TEXT);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  await expect(drafts(page)).toHaveText('Drafts1');

  await page.getByLabel('Title').fill('Two Sum, kept');
  await page.getByLabel('Summary').fill('Kept through a reload.');
  // Saved shortly after the change: a reload finds it on the server.
  const id = page.url().split('/drafts/')[1]!;
  await expect.poll(async () => JSON.stringify(await mockApi(page, `/drafts/${id}`))).toContain('Kept through a reload.');
  await page.reload();
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum, kept');
  await expect(page.getByLabel('Summary')).toHaveValue('Kept through a reload.');

  await drafts(page).click();
  await expect(page.getByRole('list', { name: 'Drafts' }).getByRole('listitem')).toContainText(['Two Sum, kept']);
  await expect(page.getByRole('list', { name: 'Drafts' }).getByRole('listitem')).toContainText(['Edited']);
  await page.getByRole('link', { name: /Two Sum, kept/ }).click();
  await page.getByRole('button', { name: 'Save to library' }).first().click();
  await expect(page).toHaveURL(/\/items\/[^/]+\/saved$/);
  await expect(drafts(page)).toHaveText('Drafts');
  await drafts(page).click();
  await expect(page.getByRole('heading', { name: 'No drafts' })).toBeVisible();
});

test('jobs: a running job is cancelled from the AI jobs list, and the draft keeps what it had', async ({ page }) => {
  await open(page, '/new');
  // The mock takes a minute over a generation asked with MOCK:SLOW.
  await page.getByLabel('What you have').fill('two sum MOCK:SLOW');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText('Drafting…')).toBeVisible();
  await drafts(page).click();
  await expect(page.getByRole('list', { name: 'Drafts' }).getByRole('listitem')).toContainText('Drafting…');

  await jobsEntry(page).click();
  const row = jobsWindow(page).getByRole('listitem');
  await expect(row).toContainText('two sum MOCK:SLOW');
  await expect(row).toContainText(/Draft · \d+\u00a0s/);
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(row).toContainText('Draft · Cancelled');
  await expect(page.getByRole('list', { name: 'Drafts' }).getByRole('listitem')).toContainText('Not drafted');

  // Dismissed, it is gone; the draft stays, with its input.
  await row.getByRole('button', { name: 'Dismiss two sum MOCK:SLOW' }).click();
  await expect(jobsWindow(page)).toHaveCount(0);
  await page.getByRole('link', { name: /two sum MOCK:SLOW/ }).click();
  await expect(page.getByLabel('What you have')).toHaveValue('two sum MOCK:SLOW');
  await expect(page.getByRole('button', { name: 'Draft with AI' })).toBeVisible();
});

test('jobs: a running job’s row leads to its draft; the list closes on Escape and gives focus back', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum MOCK:SLOW');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText('Drafting…')).toBeVisible();
  const draft = new URL(page.url()).pathname;
  await page.getByRole('link', { name: /^All items/ }).click();

  await jobsEntry(page).click();
  // Focus goes into the list as it opens, and back to the footer as Escape closes it.
  await expect(jobsWindow(page).getByRole('button', { name: 'Minimise AI jobs' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(jobsWindow(page)).toHaveCount(0);
  await expect(jobsEntry(page)).toBeFocused();
  await expect(jobsEntry(page)).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('Enter');
  const row = jobsWindow(page).getByRole('listitem');
  await expect(row).toContainText(/Draft · \d+\u00a0s/);
  // Still running, its row is a link to the draft, which shows the progress.
  await expect(row.getByRole('link')).toHaveAttribute('href', draft);
  await row.getByRole('link', { name: /two sum MOCK:SLOW/ }).click();
  await expect(page).toHaveURL(new RegExp(`${draft}$`));
  await expect(page.getByText('Drafting…')).toBeVisible();
  await expect(jobsWindow(page)).toHaveCount(0);
  // Still running, it stays listed on its own screen.
  await expect(jobsEntry(page)).toHaveAccessibleName('AI jobs: 1 running');
});

test('jobs: on the rail, the jobs entry counts them and opens the same list', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum MOCK:SLOW');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText('Drafting…')).toBeVisible();
  // A problem's workspace starts with the navigation as a rail.
  await page.getByRole('link', { name: /^All items/ }).click();
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  const rail = page.locator('.sidebar.is-rail');
  await expect(rail).toBeVisible();
  const entry = rail.getByRole('button', { name: 'AI jobs: 1 running' });
  await expect(entry).toBeVisible();
  await expect(entry.locator('.rail-badge')).toHaveText('1');

  await entry.click();
  await expect(jobsWindow(page).getByRole('listitem')).toContainText('two sum MOCK:SLOW');
  await page.keyboard.press('Escape');
  await expect(jobsWindow(page)).toHaveCount(0);
  await expect(entry).toBeFocused();
});

test('jobs: on a narrow window the menu button is marked, and the list waits in the drawer', async ({ page }) => {
  // The sidebar is a drawer below 900px.
  await page.setViewportSize({ width: 800, height: 800 });
  await open(page, '/new', 'default');
  const dot = page.locator('.topbar .topbar-jobs-dot');
  await expect(dot).toHaveCount(0);
  await page.getByLabel('What you have').fill(TWO_SUM_TEXT);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText('Drafting…')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: /^All items/ }).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/is-open/);
  await expect(dot).toBeVisible();

  // It finishes while the drawer is closed: the list does not open, and the job stays listed.
  await expect(page.locator('.sidebar .svc-jobs')).toHaveAttribute('aria-label', 'AI jobs: 1 done', { timeout: 10_000 });
  await expect(jobsWindow(page)).toHaveCount(0);
  await expect(dot).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(jobsWindow(page)).toHaveCount(0);
  await jobsEntry(page).click();
  await expect(jobsWindow(page).getByRole('listitem')).toContainText('Draft · Ready');
  // Escape closes the list first, then the drawer.
  await page.keyboard.press('Escape');
  await expect(jobsWindow(page)).toHaveCount(0);
  await expect(page.locator('.sidebar')).toHaveClass(/is-open/);
});

test('jobs: generated test cases wait for their page, and are shown there once', async ({ page }) => {
  await open(page, `/items/${TWO_SUM}/tests/generate`, 'default');
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await expect(page.getByText('Writing a solution and test cases…')).toBeVisible();
  // Leaving does not stop it, and asks nothing.
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Test cases' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const row = jobsWindow(page).getByRole('listitem');
  await expect(row).toContainText('Test cases · Ready', { timeout: 10_000 });
  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/items/${TWO_SUM}/tests/generate$`));
  await expect(page.getByRole('heading', { name: 'Proposed cases' })).toBeVisible();
  await expect(jobsWindow(page)).toHaveCount(0);

  // Collected: coming back again starts afresh.
  await page.getByRole('link', { name: 'Discard' }).click();
  await page.getByRole('dialog', { name: 'Discard the proposed test cases?' }).getByRole('button', { name: 'Discard proposals' }).click();
  await page.getByRole('link', { name: /Generate/ }).first().click();
  await expect(page.getByRole('button', { name: 'Generate test cases', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proposed cases' })).toHaveCount(0);
});

test('jobs: code generated after its edit page was left is offered there, not applied', async ({ page }) => {
  await open(page, `/items/${COIN_CHANGE}/edit`, 'default');
  const section = page.getByRole('region', { name: 'What you write' });
  const starter = section.locator('.starter-frame .cm-content');
  await expect(starter).toContainText('data = sys.stdin.read().split()');
  await section.getByRole('button', { name: 'Generate code' }).click();
  await expect(section.getByText('Writing code for 5 languages…')).toBeVisible();
  // Nothing was edited, so leaving asks nothing.
  await page.locator('.review-bar').getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(new RegExp(`/items/${COIN_CHANGE}$`));

  const row = jobsWindow(page).getByRole('listitem');
  await expect(row).toContainText('Code · Ready', { timeout: 10_000 });
  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/items/${COIN_CHANGE}/edit$`));
  await expect(section.getByText('Generated code is ready')).toBeVisible();
  // The form is as it was until the code is applied.
  await expect(starter).toContainText('data = sys.stdin.read().split()');
  await section.getByRole('button', { name: 'Apply generated code' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Wrote starter code for 5 languages.' })).toBeVisible();
  await expect(starter).toContainText('n, amount = map(int, input().split())');
  await expect(section.getByText('Generated code is ready')).toHaveCount(0);
});

test('jobs: a draft that fails while its page is left is listed as failed, and its page says so and offers to try again', async ({ page }) => {
  await open(page, '/new', 'default');
  // The mock ends a generation asked with MOCK:FAIL as an error of the provider.
  await page.getByLabel('What you have').fill('two sum MOCK:FAIL');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText('Drafting…')).toBeVisible();
  await page.getByRole('link', { name: /^All items/ }).click();

  const row = jobsWindow(page).getByRole('listitem');
  await expect(row).toContainText('Draft · Failed', { timeout: 10_000 });
  await row.getByRole('link').click();
  const failed = page.getByRole('alert').filter({ hasText: 'Drafting failed' });
  await expect(failed).toContainText('The AI provider returned an error');
  await expect(jobsWindow(page)).toHaveCount(0);

  // Trying again asks again, from the same input.
  await expect(page.getByLabel('What you have')).toHaveValue('two sum MOCK:FAIL');
  await failed.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Drafting…')).toBeVisible();
});

test('jobs: a revision that fails says so, keeps the draft, and is asked again', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill(TWO_SUM_TEXT);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum');

  await page.getByRole('button', { name: 'Ask for a revision' }).click();
  await page.getByLabel('What to change').fill('make it harder MOCK:FAIL');
  await page.getByRole('button', { name: 'Revise draft' }).click();
  const failed = page.getByRole('alert').filter({ hasText: 'The revision failed' });
  await expect(failed).toContainText('The AI provider returned an error');
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum');

  await failed.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Revising the draft…')).toBeVisible();
  await expect(failed).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum');
});

test('jobs: a revision running on its own draft is listed; its row only closes the list', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill(TWO_SUM_TEXT);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum');
  const draft = new URL(page.url()).pathname;
  await expect(jobsEntry(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Ask for a revision' }).click();
  await page.getByLabel('What to change').fill('make it harder MOCK:SLOW');
  await page.getByRole('button', { name: 'Revise draft' }).click();
  await expect(page.getByText('Revising the draft…')).toBeVisible();
  await expect(jobsEntry(page)).toHaveAccessibleName('AI jobs: 1 running');
  await expect(jobsEntry(page)).toHaveText('1 running');

  await jobsEntry(page).click();
  const row = jobsWindow(page).getByRole('listitem');
  await expect(row).toContainText(/Draft · \d+\u00a0s/);
  await expect(row.getByRole('link')).toHaveAttribute('href', draft);
  await row.getByRole('link').click();
  await expect(jobsWindow(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${draft}$`));
  await expect(page.getByText('Revising the draft…')).toBeVisible();
});

test('jobs: a revision that finishes on its own draft leaves the footer, and the list stays closed', async ({ page }) => {
  await open(page, '/new', 'default');
  await page.getByLabel('What you have').fill(TWO_SUM_TEXT);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum', { timeout: 10_000 });
  await expect(jobsEntry(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Ask for a revision' }).click();
  await page.getByLabel('What to change').fill('make it harder');
  await page.getByRole('button', { name: 'Revise draft' }).click();
  await expect(page.getByText('Revising the draft…')).toBeVisible();
  await expect(jobsEntry(page)).toHaveText('1 running');

  // Taken in by the draft: gone from the footer, without opening the list.
  await expect(page.getByText('Revising the draft…')).toHaveCount(0, { timeout: 10_000 });
  await expect(jobsEntry(page)).toHaveCount(0);
  await expect(jobsWindow(page)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /^Draft “/ })).toHaveCount(0);
});

test('jobs: test cases generating on their own page are listed, and leave the footer once shown there', async ({ page }) => {
  await open(page, `/items/${TWO_SUM}/tests/generate`, 'default');
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await expect(page.getByText('Writing a solution and test cases…')).toBeVisible();
  await expect(jobsEntry(page)).toHaveAccessibleName('AI jobs: 1 running');
  await jobsEntry(page).click();
  await expect(jobsWindow(page).getByRole('listitem')).toContainText(/Test cases · (Queued|\d+\u00a0s)/);

  await expect(page.getByRole('heading', { name: 'Proposed cases' })).toBeVisible({ timeout: 10_000 });
  await expect(jobsEntry(page)).toHaveCount(0);
  await expect(jobsWindow(page)).toHaveCount(0);
});

test('jobs: a server restart ends a running job as interrupted', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum MOCK:SLOW');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText('Drafting…')).toBeVisible();

  await page.evaluate(() => (window as unknown as { __codeatrophyMock: { restart: () => void } }).__codeatrophyMock.restart());
  const failed = page.getByRole('alert').filter({ hasText: 'Drafting failed' });
  await expect(failed).toContainText('It stopped before this finished. Start it again.');
  await expect(page.getByText('Drafting…')).toHaveCount(0);
});

test('jobs: test cases whose generation failed while their page was left show the error there', async ({ page }) => {
  await open(page, `/items/${TWO_SUM}/tests/generate`, 'default');
  await page.getByLabel('Anything to focus on? (optional)').fill('MOCK:FAIL');
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await expect(page.getByText('Writing a solution and test cases…')).toBeVisible();
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Test cases' }).click();

  const row = jobsWindow(page).getByRole('listitem');
  await expect(row).toContainText('Test cases · Failed', { timeout: 10_000 });
  await row.getByRole('link').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Generation failed' })).toContainText('The AI provider returned an error');
  await expect(page.getByRole('heading', { name: 'Proposed cases' })).toHaveCount(0);
  await expect(jobsWindow(page)).toHaveCount(0);
});

test('drafts: a draft changed elsewhere is reloaded on the next edit, and says so', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill(TWO_SUM_TEXT);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum');
  const id = page.url().split('/drafts/')[1]!;
  await expect.poll(async () => (await mockApi<{ state: string }>(page, `/drafts/${id}`)).state).toBe('ready');

  // Another tab renames it.
  type Kept = { revision: number; content: { form: { title: string } } };
  const kept = await mockApi<Kept>(page, `/drafts/${id}`);
  await mockApi(page, `/drafts/${id}`, { method: 'PATCH', body: { content: { ...kept.content, form: { ...kept.content.form, title: 'Two Sum, from the other tab' } }, title: 'Two Sum, from the other tab', expectedRevision: kept.revision } });

  // An edit here is refused, and the draft is read again.
  await page.getByLabel('Summary').fill('Edited here.');
  await expect(page.getByText('This draft changed elsewhere, so it was reloaded.')).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum, from the other tab');
});

test('drafts: an edit the server cannot take is not saved yet, and says why', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill(TWO_SUM_TEXT);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Two Sum');
  const id = page.url().split('/drafts/')[1]!;
  await expect.poll(async () => (await mockApi<{ state: string }>(page, `/drafts/${id}`)).state).toBe('ready');

  await mockApi(page, `/drafts/${id}`, { method: 'DELETE' });
  await page.getByLabel('Summary').fill('Edited here.');
  await expect(page.getByRole('status').filter({ hasText: /^Not saved yet: / })).toBeVisible();
});

test('drafts: a variant is drafted from the Variants tab and listed as one; discarded, its address says it is gone', async ({ page }) => {
  await open(page, `/items/${TWO_SUM}?tab=variants`);
  await page.getByRole('tabpanel').getByRole('link', { name: /^Harder/ }).click();
  await page.getByRole('button', { name: 'Draft another problem' }).click();
  await expect(page.getByLabel('Title')).not.toHaveValue('');
  const address = new URL(page.url()).pathname;

  await drafts(page).click();
  const listed = page.getByRole('list', { name: 'Drafts' }).getByRole('listitem');
  await expect(listed).toHaveCount(1);
  await expect(listed.locator('.draft-kind')).toHaveText('Variant');
  await expect(listed).toContainText('Ready to review');

  await listed.getByRole('button', { name: /^Discard / }).click();
  await page.getByRole('dialog', { name: 'Discard this draft?' }).getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByRole('heading', { name: 'No drafts' })).toBeVisible();
  await expect(drafts(page)).toHaveText('Drafts');

  // A link to it, from the history or a bookmark.
  await page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, address);
  await expect(page.getByRole('heading', { name: 'This draft is gone' })).toBeVisible();
});
