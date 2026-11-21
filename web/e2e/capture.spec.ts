import { expect, test } from '@playwright/test';
import { open, TWO_SUM_TEXT } from './support';

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
  await open(page, '/items/11111111-1111-4111-8111-000000000001/tests', 'default');
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
