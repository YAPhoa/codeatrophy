import { expect, test, type Locator, type Page } from '@playwright/test';
import { codeColours, codeRoleBackground, open, SEED } from './support';

// Mermaid diagrams and images embedded as data URLs in rendered Markdown. The
// seed's "Untrusted Markdown" reading has a diagram that draws, one that does
// not parse, and an SVG image as a data URL with a script inside.
const UNTRUSTED = '/items/11111111-1111-4111-8111-000000000023';
const RAFT = `/items/${SEED.raftLeaderElection}`;
const B_TREES = '/items/11111111-1111-4111-8111-000000000018';

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

test('markdown: a code block takes the colours of the code theme\'s roles, in light and in dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, B_TREES);
  const block = page.locator('.md pre code.language-python');
  await expect(block).toContainText('def search(node, key):');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const { drawn, role } = await codeColours(block, [
      ['def', 'declare'],
      ['search', 'function'],
      ['len', 'type'],
      ['None', 'constant'],
      ['# first separator > key', 'comment'],
    ]);
    expect(drawn).toEqual(role);
    expect(await block.evaluate((el) => getComputedStyle(el).color)).toBe(
      await block.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--code-text)';
        el.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }),
    );
    expect(await page.locator('.md pre').first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await codeRoleBackground(page, 'block-background'));
  }
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

// A reading whose answers wait in collapsible blocks, added to the mock's
// library before the app loads it.
const EXERCISES = '/items/99999999-9999-4999-8999-0000000000d1';
const EXERCISES_BODY = [
  '## Warm-up',
  '',
  'What is the time complexity of binary search?',
  '',
  '<details>',
  '<summary>Answer</summary>',
  '',
  'It is $O(\\log n)$: each step halves the range.',
  '',
  '</details>',
  '',
  '## Practice',
  '',
  'Write it iteratively.',
  '',
  '<details>',
  '<summary>Solution</summary>',
  '',
  '### Worked solution',
  '',
  '```python',
  'def search(xs, x):',
  '    lo, hi = 0, len(xs)',
  '```',
  '',
  '</details>',
  '',
  ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of filler, so the page scrolls.\n`),
  '## Further reading',
  '',
  ...Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 41} of filler.\n`),
].join('\n');

async function withExercises(page: Page): Promise<void> {
  await page.addInitScript((body) => {
    type Item = { id: string; type: string; title: string; body: string; tags: string[]; seq: number };
    type Mock = { db: { items: Map<string, Item>; nextSeq: () => number } };
    let mock: Mock | undefined;
    Object.defineProperty(window, '__codeatrophyMock', {
      configurable: true,
      get: () => mock,
      set: (m: Mock) => {
        mock = m;
        const base = [...m.db.items.values()].find((i) => i.type === 'reading')!;
        const id = '99999999-9999-4999-8999-0000000000d1';
        m.db.items.set(id, { ...base, id, title: 'Binary search exercises', body, tags: [], seq: m.db.nextSeq() });
      },
    });
  }, EXERCISES_BODY);
}

test('markdown: an answer in a details block is hidden until its summary is clicked, and the outline opens it', async ({ page }) => {
  await withExercises(page);
  await open(page, EXERCISES);
  const body = page.locator('.md');
  const answer = body.locator('details').filter({ has: page.locator('summary', { hasText: 'Answer' }) });
  await expect(answer).toHaveCount(1);
  await expect(answer.getByText('each step halves the range')).toBeHidden();
  await expect(answer.locator('.katex')).toBeHidden();

  await answer.getByText('Answer', { exact: true }).click();
  await expect(answer).toHaveAttribute('open', '');
  await expect(answer.getByText('each step halves the range')).toBeVisible();
  await expect(answer.locator('.katex')).toBeVisible();
  // Clicking the summary again folds it away.
  await answer.getByText('Answer', { exact: true }).click();
  await expect(answer.getByText('each step halves the range')).toBeHidden();

  // A heading inside a closed block is in the outline; choosing it opens the block and lands on it.
  const solution = body.locator('details').filter({ has: page.locator('summary', { hasText: 'Solution' }) });
  const heading = body.getByRole('heading', { name: 'Worked solution' });
  await expect(heading).toBeHidden();
  // With the block just below the top of the pane, the section being read is
  // the one around it, not the hidden heading inside.
  await body.getByRole('heading', { name: 'Practice' }).evaluate((h) => h.scrollIntoView({ block: 'start' }));
  // With the notes beside the text, the outline is folded into the bar.
  await page.getByRole('button', { name: 'On this page' }).click();
  const outline = page.getByRole('dialog', { name: 'On this page' });
  await expect(outline.getByRole('link', { name: 'Practice' })).toHaveAttribute('aria-current', 'location');
  await expect(outline.getByRole('link', { name: 'Worked solution' })).not.toHaveAttribute('aria-current');
  await outline.getByRole('link', { name: 'Worked solution' }).click();
  await expect(solution).toHaveAttribute('open', '');
  await expect(heading).toBeInViewport();
  await expect(page).toHaveURL(/#h-worked-solution$/);
  await expect(solution.locator('pre code')).toContainText('def search');
  // The other closed block stays closed.
  await expect(answer).not.toHaveAttribute('open');
});

// The seed's "Consistent Hashing" reading shows its code in a few languages,
// in two tab groups: Python, Go and C++, then Go and Python.
const HASHING = '/items/11111111-1111-4111-8111-000000000017';

test('markdown: language tabs switch by pointer and keyboard, together across the page, and are remembered', async ({ page }) => {
  await open(page, HASHING);
  const groups = page.locator('.md .md-code-tabs');
  await expect(groups).toHaveCount(2);
  const [first, second] = [groups.nth(0), groups.nth(1)];
  await expect(first.getByRole('tab')).toHaveText(['Python', 'Go', 'C++']);
  await expect(second.getByRole('tab')).toHaveText(['Go', 'Python']);
  const shown = (group: Locator) => group.locator('[role="tabpanel"]:not([hidden]) code');
  await expect(first.getByRole('tab', { name: 'Python' })).toHaveAttribute('aria-selected', 'true');
  await expect(shown(first)).toHaveClass(/language-python/);
  await expect(shown(second)).toHaveClass(/language-go/);
  // Each tab is highlighted, and the selected one is drawn as part of the code box.
  await expect(shown(first).locator('.hljs-keyword').first()).toBeVisible();
  const tab = await first.getByRole('tab', { name: 'Python' }).boundingBox();
  const box = await shown(first).locator('xpath=..').boundingBox();
  expect(Math.abs((tab?.y ?? 0) + (tab?.height ?? 0) - 1 - (box?.y ?? 0))).toBeLessThanOrEqual(1);

  // A click picks Go here and in the other group.
  await first.getByRole('tab', { name: 'Go' }).click();
  await expect(shown(first)).toHaveClass(/language-go/);
  await expect(shown(first)).toBeVisible();
  await expect(shown(second)).toHaveClass(/language-go/);

  // The arrows, Home and End move the selection and the focus; C++ is only in the first group.
  await page.keyboard.press('ArrowRight');
  await expect(first.getByRole('tab', { name: 'C++' })).toBeFocused();
  await expect(first.getByRole('tab', { name: 'C++' })).toHaveAttribute('tabindex', '0');
  await expect(first.getByRole('tab', { name: 'Go' })).toHaveAttribute('tabindex', '-1');
  await expect(shown(first)).toHaveClass(/language-cpp/);
  await expect(shown(second)).toHaveClass(/language-go/);
  await page.keyboard.press('ArrowRight');
  await expect(first.getByRole('tab', { name: 'Python' })).toBeFocused();
  await expect(shown(second)).toHaveClass(/language-python/);
  await page.keyboard.press('End');
  await expect(first.getByRole('tab', { name: 'C++' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(first.getByRole('tab', { name: 'Python' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(first.getByRole('tab', { name: 'C++' })).toBeFocused();
  await expect(first.locator('[role="tabpanel"]:not([hidden])')).toHaveAttribute('aria-labelledby', (await first.getByRole('tab', { name: 'C++' }).getAttribute('id')) ?? '');

  // The second group picks Go, and the choice outlives a reload.
  await second.getByRole('tab', { name: 'Go' }).click();
  await expect(shown(first)).toHaveClass(/language-go/);
  await page.reload();
  await expect(shown(page.locator('.md .md-code-tabs').nth(0))).toHaveClass(/language-go/);
  await expect(shown(page.locator('.md .md-code-tabs').nth(1))).toHaveClass(/language-go/);
});

test('markdown: a row of language tabs too wide for a narrow window scrolls on its own', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 800 });
  await open(page, HASHING);
  const row = page.locator('.md .md-code-tabs-list').first();
  await expect(row.getByRole('tab')).toHaveCount(3);
  await row.evaluate((el) => {
    el.style.maxWidth = '120px';
  });
  expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
