import { expect, test, type Page } from '@playwright/test';
import { open } from './support';

// The "Text width" preference: the reader's quick switch and the Settings
// control edit the same per-browser choice. The seed's Raft reading has an
// outline and a diagram.
const RAFT = '/items/11111111-1111-4111-8111-000000000024';

const columnWidth = (page: Page) => page.locator('.reader-article').evaluate((el) => Math.round(el.getBoundingClientRect().width));

async function chooseWidth(page: Page, label: string) {
  await page.getByRole('button', { name: /^Text width: / }).click();
  const menu = page.getByRole('menu', { name: 'Text width' });
  await menu.getByRole('menuitemradio', { name: label }).click();
  await expect(menu).toBeHidden();
}

test('text width: the reader switch changes the column at once, and the choice lasts', async ({ page }) => {
  // Wide enough that every choice differs: the sidebar, the text and the outline all fit.
  await page.setViewportSize({ width: 1800, height: 900 });
  await open(page, RAFT);
  await expect(page.locator('.md-mermaid svg')).toBeVisible();
  const outline = page.getByRole('navigation', { name: 'On this page' });
  await expect(outline).toBeVisible();

  // Standard until chosen; the switch names the current choice and marks it.
  const button = page.getByRole('button', { name: 'Text width: Standard' });
  await expect(button).toBeVisible();
  expect(await columnWidth(page)).toBe(720);
  await button.click();
  await expect(page.getByRole('menuitemradio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await chooseWidth(page, 'Wide');
  await expect(page.getByRole('button', { name: 'Text width: Wide' })).toBeVisible();
  await expect.poll(() => columnWidth(page)).toBe(940);
  // There is room for the outline beside a Standard or a Wide column here.
  await expect(outline).toBeVisible();
  await expect(page.getByRole('button', { name: 'On this page' })).toHaveCount(0);
  await chooseWidth(page, 'Narrow');
  await expect.poll(() => columnWidth(page)).toBe(540);
  await chooseWidth(page, 'Full');
  await expect.poll(() => columnWidth(page)).toBeGreaterThan(940);
  // Full still leaves the outline its place, and the outline still follows the reading.
  await expect(outline).toBeVisible();
  // The column eases across to its new place (a transform); measure where it comes to rest.
  await expect.poll(() => page.locator('.reader-article').evaluate((el) => el.getAnimations().length)).toBe(0);
  const [text, nav] = await Promise.all([page.locator('.reader-article').boundingBox(), outline.boundingBox()]);
  expect(text!.x + text!.width).toBeLessThan(nav!.x);
  await page.locator('.reader-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
  await expect(outline.locator('a[aria-current="location"]')).toHaveText('Related items');

  await chooseWidth(page, 'Wide');
  await expect.poll(() => columnWidth(page)).toBe(940);

  // Kept in the browser across a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Text width: Wide' })).toBeVisible();
  await expect.poll(() => columnWidth(page)).toBe(940);

  // Settings shows the same choice, and a change there reaches the reader.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Preferences' }).click();
  const setting = page.getByRole('radiogroup', { name: 'Text width' });
  await expect(setting.getByRole('radio', { name: 'Wide' })).toBeChecked();
  await setting.getByText('Narrow').click();
  await expect(setting.getByRole('radio', { name: 'Narrow' })).toBeChecked();
  await page.goto(`${RAFT}?mock=fast`);
  await expect(page.getByRole('button', { name: 'Text width: Narrow' })).toBeVisible();
  await expect.poll(() => columnWidth(page)).toBe(540);
});

for (const width of [1280, 1000]) {
  test(`text width: Full never scrolls the page sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, RAFT);
    await expect(page.locator('.md-mermaid svg')).toBeVisible();
    await chooseWidth(page, 'Full');
    await expect(page.getByRole('button', { name: 'Text width: Full' })).toBeVisible();

    const sideways = () =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.reader-scroll')!;
        return { page: document.documentElement.scrollWidth - window.innerWidth, pane: scroller.scrollWidth - scroller.clientWidth };
      });
    await expect.poll(sideways).toEqual({ page: 0, pane: 0 });
    // The text column gives way rather than push anything out of the pane.
    const [text, pane] = await Promise.all([page.locator('.reader-article').boundingBox(), page.locator('.reader-scroll').boundingBox()]);
    expect(text!.x + text!.width).toBeLessThanOrEqual(pane!.x + pane!.width);

    // With the notes open too.
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Private notes' })).toBeVisible();
    await expect.poll(sideways).toEqual({ page: 0, pane: 0 });
  });
}

test('text width: the chosen width wins over the outline, which folds into the bar when there is no room for both', async ({ page }) => {
  // The sidebar open: the pane holds a Standard column, a little short of
  // its cap, beside the outline, but not a Wide one.
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, RAFT);
  await expect(page.locator('.md-mermaid svg')).toBeVisible();
  const docked = page.locator('.reader-layout').getByRole('navigation', { name: 'On this page' });
  const button = page.getByRole('button', { name: 'On this page' });

  await expect(docked).toBeVisible();
  await expect(button).toHaveCount(0);
  const standard = await columnWidth(page);
  expect(standard).toBeLessThan(720);
  expect(standard).toBeGreaterThanOrEqual(640);
  await chooseWidth(page, 'Wide');
  await expect.poll(() => columnWidth(page)).toBe(940);
  await expect(button).toBeVisible();
  await expect(docked).toHaveCount(0);
  await chooseWidth(page, 'Full');
  await expect.poll(() => columnWidth(page)).toBeGreaterThan(940);
  await expect(button).toBeVisible();

  // The folded outline: the section being read is marked, and a pick goes there and closes it.
  await button.click();
  const pop = page.getByRole('dialog', { name: 'On this page' });
  await expect(pop.locator('a[aria-current="location"]')).toHaveText('States');
  await pop.getByRole('link', { name: 'Timing' }).click();
  await expect(pop).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  const timingTop = () =>
    page.evaluate(() => {
      const heading = [...document.querySelectorAll('.reader-article h2')].find((h) => h.textContent === 'Timing')!;
      return Math.round(heading.getBoundingClientRect().top - document.querySelector('.reader-scroll')!.getBoundingClientRect().top);
    });
  await expect.poll(timingTop).toBeLessThan(60);
  await button.click();
  await expect(pop.locator('a[aria-current="location"]')).toHaveText('Timing');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // A Narrow or Standard column leaves room, so the outline docks again.
  await chooseWidth(page, 'Standard');
  await expect(docked).toBeVisible();
  await expect(button).toHaveCount(0);
  await expect.poll(() => columnWidth(page)).toBe(standard);
  await chooseWidth(page, 'Narrow');
  await expect(docked).toBeVisible();
  await expect(button).toHaveCount(0);
  expect(await columnWidth(page)).toBe(540);
});


test('text width: the outline and the header grow with the reading text size', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await open(page, RAFT);
  const outline = page.locator('.reader-layout').getByRole('navigation', { name: 'On this page' });
  await expect(outline).toBeVisible();
  const size = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontSize);
  const outlineWidth = () => outline.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(await outlineWidth()).toBe(220);
  expect(await size('.reader-outline a')).toBe('13px');
  expect(await size('.reader-outline h2')).toBe('12px');
  expect(await size('.reader-head h1')).toBe('30px');
  expect(await size('.reader-meta')).toBe('13px');

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Preferences' }).click();
  await page.getByRole('radiogroup', { name: 'Reading text size' }).getByText('Large').click();
  await page.goto(`${RAFT}?mock=fast`);
  await expect(outline).toBeVisible();
  // The docked outline is as wide as the docking reckoned with, and its entries and indent scale.
  expect(await outlineWidth()).toBe(253);
  expect(parseFloat(await size('.reader-outline a'))).toBeCloseTo(14.95, 1);
  expect(parseFloat(await size('.reader-outline h2'))).toBeCloseTo(13.8, 1);
  expect(parseFloat(await size('.reader-head h1'))).toBeCloseTo(34.5, 1);
  expect(parseFloat(await size('.reader-meta'))).toBeCloseTo(14.95, 1);
  // Tag chips keep the interface size.
  expect(await size('.reader-head .chip')).toBe('12px');
  const [text, nav] = await Promise.all([page.locator('.reader-article').boundingBox(), outline.boundingBox()]);
  expect(text!.x + text!.width).toBeLessThan(nav!.x);

  // Folded, the panel grows with it.
  await chooseWidth(page, 'Wide');
  await page.setViewportSize({ width: 1280, height: 800 });
  const button = page.getByRole('button', { name: 'On this page' });
  await button.click();
  const pop = page.getByRole('dialog', { name: 'On this page' });
  // offsetWidth: the panel scales in as it opens.
  expect(await pop.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(322);
});
