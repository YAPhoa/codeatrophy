import { expect, test, type Page } from '@playwright/test';
import { open } from './support';

// Mermaid diagrams and images embedded as data URLs in rendered Markdown. The
// seed's "Untrusted Markdown" reading has a diagram that draws, one that does
// not parse, and an SVG image as a data URL with a script inside.
const UNTRUSTED = '/items/11111111-1111-4111-8111-000000000023';
const RAFT = '/items/11111111-1111-4111-8111-000000000024';

const noDialogs = (page: Page) =>
  page.on('dialog', (dialog) => {
    throw new Error(`a dialog opened: ${dialog.message()}`);
  });

test('markdown: a mermaid fence is drawn, a broken one falls back to its source, and a data:image shows', async ({ page }) => {
  noDialogs(page);
  await open(page, UNTRUSTED);
  const body = page.locator('.md');

  const diagram = body.locator('.md-mermaid svg');
  await expect(diagram).toHaveCount(1);
  await expect(diagram).toBeVisible();
  await expect(diagram).toContainText('Raw HTML?');
  // Strict: the click directive leaves no link or handler behind.
  expect(await body.locator('.md-mermaid').evaluate((box) => [...box.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name)).filter((name) => /href|^on/i.test(name)))).toEqual([]);
  expect(await body.locator('.md-mermaid').innerHTML()).not.toMatch(/javascript:/i);

  // The broken one is its source as a code block, with a quiet note.
  const source = body.locator('pre code.language-mermaid');
  await expect(source).toHaveCount(1);
  await expect(source).toContainText('A[Unclosed --> B');
  await expect(body.getByText('This diagram could not be drawn.')).toHaveCount(1);
  await expect(body.locator('[aria-roledescription="error"]')).toHaveCount(0);

  // Nothing mermaid worked in is left in the page.
  expect(await page.evaluate(() => [...document.body.children].filter((el) => /^d?mermaid-|^cy$/.test(el.id) || el.matches('.mermaidTooltip') || el.getAttribute('aria-hidden') === 'true' && el.matches('div[style*="-100000px"]')).length)).toBe(0);

  // The data URL image is shown at once, as a picture.
  const image = body.getByRole('img', { name: 'An embedded SVG' });
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', /^data:image\/svg\+xml,/);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(168);
  // The tracking pixel beside it still waits to be asked for.
  await expect(body.getByRole('button', { name: /Load image .*tracking pixel/ })).toBeVisible();

  // A wide diagram scrolls in its box; the page itself does not.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('markdown: a diagram follows the theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, RAFT);
  const diagram = page.locator('.md-mermaid svg');
  await expect(diagram).toContainText('Candidate');
  const light = await diagram.evaluate((svg) => svg.querySelector('style')?.textContent ?? '');
  expect(light).toContain('#e0e7e3');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => diagram.evaluate((svg) => svg.querySelector('style')?.textContent ?? '')).toContain('#1f2937');
});

test('markdown: the editor preview draws a diagram once typing pauses', async ({ page }) => {
  await open(page, `${UNTRUSTED}/edit`);
  await expect(page.getByRole('radio', { name: 'Side by side' })).toBeChecked();
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.locator('.md-mermaid svg')).toHaveCount(1);
  const drawnId = () => preview.locator('.md-mermaid svg').first().getAttribute('id');
  const before = Number((await drawnId())?.replace(/\D/g, ''));

  const editor = page.getByRole('textbox', { name: 'Text (Markdown)' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('```mermaid\nsequenceDiagram\nReader->>Server: GET item\nServer-->>Reader: Markdown\n```\n\n', { delay: 15 });
  await expect(preview.locator('.md-mermaid svg')).toHaveCount(2);
  await expect(preview.locator('.md-mermaid svg').first()).toContainText('Server');
  // Typed at once, it was drawn a few times at most, not once a keystroke.
  const after = Number((await drawnId())?.replace(/\D/g, ''));
  expect(after - before).toBeLessThan(10);
});
