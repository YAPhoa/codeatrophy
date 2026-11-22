import { expect, test, type Page } from '@playwright/test';
import { open, SEED, TWO_SUM_TEXT } from './support';

test('capture: drafting with AI keeps the text in view on the way to the draft', async ({ page }) => {
  await open(page, '/new');
  await page.locator('#capture-text').fill(TWO_SUM_TEXT);
  // Every frame's text, from the click until the draft has its own page.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    const sample = () => {
      const box = document.querySelector<HTMLTextAreaElement>('#capture-text');
      if (box) seen.push(box.value);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page).toHaveURL(/\/drafts\//);
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((v) => v !== TWO_SUM_TEXT)).toEqual([]);
  // The text went with the draft: a new capture starts empty.
  await page.goto('/new?mock=fast');
  await expect(page.locator('#capture-text')).toHaveValue('');
});

test('generate tests: the model choice is there from the first frame, not added under it', async ({ page }) => {
  await open(page, `/items/${SEED.twoSum}/tests`, 'default');
  await page.getByRole('heading', { name: 'Test cases' }).waitFor();
  // Every frame, from the click until the page settles: whether its form has the model choice yet.
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { seen: boolean[] }).seen = seen;
    const sample = () => {
      if (document.querySelector('h2')?.textContent === 'Generate test cases') seen.push([...document.querySelectorAll('#main label')].some((l) => l.textContent === 'Model'));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.locator('.section-head').getByRole('link', { name: 'Generate with AI' }).click();
  await expect(page.getByLabel('Model')).toBeVisible();
  await page.waitForTimeout(300);
  const seen = await page.evaluate(() => (window as unknown as { seen: boolean[] }).seen);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((has) => !has)).toEqual([]);
});

/** What the draft on screen was last asked for, as the server keeps it. */
async function askedFor(page: Page): Promise<Record<string, unknown>> {
  const id = new URL(page.url()).pathname.split('/').pop()!;
  return page.evaluate(async (draftId) => {
    const mock = (window as unknown as { __codeatrophyMock: { fetch: (url: string) => Promise<Response> } }).__codeatrophyMock;
    const draft = (await (await mock.fetch(`/api/v1/drafts/${draftId}`)).json()) as { request: Record<string, unknown> };
    return draft.request;
  }, id);
}

test('capture: a draft asks for as many test cases as the preference says, or as chosen', async ({ page }) => {
  await open(page, '/settings/preferences');
  const preference = page.getByLabel('Test cases to generate', { exact: true });
  await preference.fill('6');
  await preference.blur();

  const nav = page.getByRole('complementary', { name: 'Navigation' });
  const count = page.locator('.capture-controls').getByLabel('Test cases', { exact: true });
  const cases = page.locator('section[aria-labelledby="cases-heading"] ol.case-cards').first().locator(':scope > li');
  await nav.getByRole('link', { name: /New item/ }).click();
  await expect(count).toHaveValue('6');
  await page.locator('#capture-text').fill(TWO_SUM_TEXT);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  expect(await askedFor(page)).toMatchObject({ testCaseCount: 6 });
  await expect(cases).toHaveCount(6);

  // Changed for one capture, and kept through a reload of the page.
  await nav.getByRole('link', { name: /New item/ }).click();
  await expect(count).toHaveValue('6');
  await page.getByRole('button', { name: 'Fewer test cases', exact: true }).click();
  await expect(count).toHaveValue('5');
  await page.locator('#capture-text').fill(TWO_SUM_TEXT);
  // Kept in this browser a moment after the last change.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('codeatrophy:capture:input') ?? '{}') as unknown)).toMatchObject({ text: TWO_SUM_TEXT, testCaseCount: 5 });
  await page.reload();
  await expect(count).toHaveValue('5');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  expect(await askedFor(page)).toMatchObject({ testCaseCount: 5 });
  await expect(cases).toHaveCount(5);

  // A reading has no test cases to ask for.
  await nav.getByRole('link', { name: /New item/ }).click();
  await page.getByRole('radiogroup', { name: 'Kind of item' }).getByText('Reading').click();
  await expect(count).toHaveCount(0);
  await page.locator('#capture-text').fill('notes on consistent hashing: a ring of nodes, virtual nodes to even out the load');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  expect(await askedFor(page)).not.toHaveProperty('testCaseCount');
});

test('capture: a test case count typed out of range is marked, then brought to the bound with a shake', async ({ page }) => {
  await open(page, '/new');
  const count = page.locator('.capture-controls').getByLabel('Test cases', { exact: true });
  await expect(count).toHaveValue('8');
  // Every class the field takes, from here on.
  await count.evaluate((el) => {
    const seen: string[] = [];
    (window as unknown as { classes: string[] }).classes = seen;
    new MutationObserver(() => seen.push(el.className)).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  const shook = () => page.evaluate(() => (window as unknown as { classes: string[] }).classes.some((c) => c.includes('is-shaking')));

  await count.fill('500');
  await expect(count).toHaveAttribute('aria-invalid', 'true');
  await count.press('Enter');
  await expect(count).toHaveValue('30');
  expect(await shook()).toBe(true);
  // Marked while it shakes, then no longer.
  await expect(count).not.toHaveAttribute('aria-invalid');

  // A value in range, an emptied field, and the buttons do not shake.
  await page.evaluate(() => (window as unknown as { classes: string[] }).classes.splice(0));
  await count.fill('12');
  await count.press('Enter');
  await expect(count).toHaveValue('12');
  await count.fill('');
  await count.press('Enter');
  await expect(count).toHaveValue('12');
  await page.getByRole('button', { name: 'More test cases', exact: true }).click();
  await expect(count).toHaveValue('13');
  expect(await shook()).toBe(false);
  await expect(count).not.toHaveAttribute('aria-invalid');
});
