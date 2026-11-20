import { expect, test, type Page } from '@playwright/test';
import { open } from '../support';

// Run against a production build (the `built` project in playwright.config.ts):
// its minifier rewrites the duration tokens (250ms becomes .25s), and anything
// timed in script reads them back from the stylesheet (lib/motion.ts).

test('built: a duration token read in script is the same length as in the stylesheet', async ({ page }) => {
  await open(page, '/');
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  // The time between a toast starting to leave and being removed: its exit, then its row closing.
  const exit = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let since: number | null = null;
          const mo = new MutationObserver(() => {
            const leaving = document.querySelector('.toast-slot.is-leaving');
            if (leaving && since === null) since = performance.now();
            if (!leaving && since !== null) {
              mo.disconnect();
              resolve(performance.now() - since);
            }
          });
          mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        }),
    );
  await page.locator('.item-row .item-check input').first().click();
  await page.locator('.bulkbar').getByRole('button', { name: /favorite/i }).click();
  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  const lasted = exit();
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  // Two of --duration-fast (250ms). Read without its unit it was gone within a frame.
  expect(await lasted).toBeGreaterThan(400);
  await expect(toast).toHaveCount(0);
});

/** How long, in ms, what `selector` matches stays in the page once `target` is clicked or loses focus. */
function lifetime(page: Page, selector: string, target: string, action: 'click' | 'blur') {
  return page.evaluate(
    ([selector, target, action]) =>
      new Promise<number>((resolve) => {
        let since: number | null = null;
        const mo = new MutationObserver(() => {
          const there = document.querySelector(selector);
          if (there && since === null) since = performance.now();
          if (!there && since !== null) {
            mo.disconnect();
            resolve(performance.now() - since);
          }
        });
        mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        document.querySelector<HTMLElement>(target)![action]();
      }),
    [selector, target, action] as const,
  );
}

test('built: a closing row stays for its exit as long as it took to open', async ({ page }) => {
  await open(page, '/');
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  const expand = page.locator('li.item-row .item-expand button').first();
  await expand.click();
  await expect(page.locator('li.item-row .collapse')).not.toHaveClass(/is-moving/);
  // --duration-fast (250ms), as the opening. Read without its unit it went within a frame.
  expect(await lifetime(page, 'li.item-row .collapse.is-closing', 'li.item-row .item-expand button', 'click')).toBeGreaterThan(200);
});

test('built: a tooltip goes almost at once', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit details…' }).click();
  const tip = page.getByRole('button', { name: 'About output comparison' });
  await tip.focus();
  const tooltip = page.getByRole('tooltip');
  await tooltip.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  // --duration-instant (50ms): longer than a frame or two, and well short of a popover's --duration-quick.
  const lasted = await lifetime(page, '.info-tip-text.is-closing', '[aria-label="About output comparison"]', 'blur');
  expect(lasted).toBeGreaterThan(30);
  expect(lasted).toBeLessThan(130);
});
