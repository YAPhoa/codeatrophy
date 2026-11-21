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
