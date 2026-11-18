import { expect, test } from '@playwright/test';
import { open } from './support';

// Keyboard, focus and screen-reader behaviour the UI is held to. Like the
// smoke suite, these run against the API mock.

test('focus: the solve editor shows a ring when it has focus', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  const host = page.locator('.editor-host');
  await host.locator('.cm-content').click();
  await expect(host).toHaveCSS('outline-style', 'solid');
});

test('confirm: a destructive dialog opens on Cancel, so Enter does not delete', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();

  const dialog = page.getByRole('dialog', { name: /^Delete/ });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Longest Substring Without Repeating Characters' })).toBeVisible();
});

test('live regions: the elapsed-time counter of a generation is not announced', async ({ page }) => {
  // Normal mock delays, so the panel stays up long enough to look at.
  await page.goto('/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it.');
  await page.getByRole('button', { name: 'Draft with AI' }).click();

  const status = page.getByRole('status').filter({ hasText: 'Drafting…' });
  await expect(status).toHaveText('Drafting…');
  await expect(page.locator('.generating-time')).toHaveText(/^\d+\u00a0s$/);
});

test('unsaved work: leaving an edited test case or an unsaved proposal asks first', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  const sections = page.getByRole('navigation', { name: 'Problem sections' });
  await sections.getByRole('link', { name: /^Test cases/ }).click();

  // An edited case: staying keeps the edit, leaving discards it.
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('Renamed and not saved');
  await sections.getByRole('link', { name: 'Solve' }).click();
  const guard = page.getByRole('dialog', { name: 'Leave without saving?' });
  await expect(guard.getByRole('button', { name: 'Stay' })).toBeFocused();
  await guard.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/\/tests$/);
  await expect(name).toHaveValue('Renamed and not saved');

  // Saved work is not guarded.
  await page.getByRole('button', { name: 'Save case' }).click();
  await expect(page.getByText('Test case saved')).toBeVisible();

  // A proposal: "Discard" and every other way out go through the same question.
  await page.getByRole('link', { name: /Generate/ }).first().click();
  await page.getByLabel('How many').fill('2');
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await expect(page.getByText('2 of 2 selected')).toBeVisible();
  await page.getByRole('link', { name: 'Discard' }).click();
  const discard = page.getByRole('dialog', { name: 'Discard the proposed test cases?' });
  await discard.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByText('2 of 2 selected')).toBeVisible();
  await page.getByRole('link', { name: 'Discard' }).click();
  await discard.getByRole('button', { name: 'Discard proposals' }).click();
  await expect(page).toHaveURL(/\/tests$/);
});

test('notes: text typed just before the tab goes away is still saved', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('tab', { name: /^Notes/ }).click();
  await page.getByLabel('Private notes (Markdown)').pressSequentially(' x');
  const state = page.locator('.notes-state');
  await expect(state).toHaveText('Unsaved');
  // Well inside the autosave delay, and without leaving the field.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(state).not.toHaveText('Unsaved', { timeout: 300 });
  await expect(state).toHaveText('Saved');
});

test('reduced motion: the mark of a generation in progress is a still frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Normal mock delays, so the generating panel stays up long enough to look at.
  await page.goto('/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it.');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  const rows = page.locator('.generating-row');
  await expect(rows).toHaveCount(5);
  for (const row of await rows.all()) await expect(row).toHaveCSS('animation-name', 'none');
  await expect(rows.nth(1)).toHaveCSS('opacity', '0');
  await expect(page.locator('.generating-token').first()).toHaveCSS('animation-name', 'none');
  const caret = page.locator('.generating-caret');
  await expect(caret).toHaveCSS('animation-name', 'none');
  await expect(caret).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 28, 23)');
});

test('deep links: the open tabs of the solve page are part of the address', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('tab', { name: /^Notes/ }).click();
  await expect(page).toHaveURL(/[?&]tab=notes/);
  await page.getByRole('button', { name: 'Show tests and results' }).click();
  await page.getByRole('tab', { name: 'Custom input' }).click();
  await expect(page).toHaveURL(/[?&]tab=notes&panel=custom|[?&]panel=custom&tab=notes/);
  // Back to a default leaves it out of the address again.
  await page.getByRole('tab', { name: 'Description' }).click();
  await expect(page).not.toHaveURL(/tab=/);

  // Arriving with the parameters opens the same view.
  const url = new URL(page.url());
  url.searchParams.set('tab', 'submissions');
  await page.goto(url.toString());
  await expect(page.getByRole('tab', { name: 'Submissions' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Custom input' })).toHaveAttribute('aria-selected', 'true');
});

test('deep links: the review step of a capture is in the history, so Back returns to the input', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it.');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
  await expect(page).toHaveURL(/[?&]step=review/);

  await page.goBack();
  await expect(page.getByLabel('What you have')).toBeVisible();
  await expect(page).not.toHaveURL(/step=/);
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Review the draft' })).toBeVisible();
});

test('deep links: an export of selected items survives in the address', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Export this item…' }).click();
  await expect(page).toHaveURL(/\/settings\/export\?.*item=/);
  await expect(page.getByRole('radio', { name: /Selected items/ })).toBeChecked();
  await expect(page.locator('.export-items')).toContainText('Two Sum');

  await page.getByRole('checkbox', { name: 'Saved solutions' }).uncheck();
  await expect(page).toHaveURL(/[?&]solutions=0/);
  await page.getByRole('radio', { name: /The whole library/ }).check();
  await expect(page).toHaveURL(/[?&]scope=all/);
});

test('deep links: the selected test case is in the address', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('navigation', { name: 'Problem sections' }).getByRole('link', { name: /^Test cases/ }).click();
  const name = page.getByLabel('Name', { exact: true });
  await expect(name).not.toHaveValue('');
  await expect(page).not.toHaveURL(/case=/);

  const second = page.getByRole('list', { name: 'Test cases' }).locator('.case-row-main').nth(1);
  await second.click();
  await expect(page).toHaveURL(/[?&]case=/);
  const selectedName = await name.inputValue();

  // Arriving by the link opens the same case. Another problem first, so the page starts afresh without a reload.
  const link = new URL(page.url());
  await page.getByRole('link', { name: 'Back to the library' }).click();
  await page.getByRole('link', { name: 'Coin Change' }).click();
  await page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, link.pathname + link.search);
  await expect(name).toHaveValue(selectedName);
});

test('forms: every text input, text area and select has a name', async ({ page }) => {
  const unnamed = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select')]
        .filter((el) => !el.name)
        .map((el) => el.outerHTML.slice(0, 120)),
    );
  await open(page, '/');
  await expect(page.getByRole('link', { name: 'Two Sum', exact: true })).toBeVisible();
  expect(await unnamed()).toEqual([]);

  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Title')).toBeVisible();
  expect(await unnamed()).toEqual([]);
  await expect(page.getByLabel('Title')).toHaveAttribute('name', 'title');
  await expect(page.getByLabel('Title')).toHaveAttribute('autocomplete', 'off');
});

test('forms: a save that cannot go through says why and moves to the field', async ({ page }) => {
  // A new collection without a name.
  await open(page, '/');
  await page.getByRole('button', { name: 'New collection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New collection' });
  const create = dialog.getByRole('button', { name: 'Create collection' });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(dialog.getByRole('alert')).toHaveText('Give the collection a name.');
  await expect(dialog.getByLabel('Name')).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // An item whose title was emptied.
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Title').fill('');
  await page.getByLabel('Source note').focus();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByLabel('Title')).toBeFocused();
  await expect(page.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
});

test('forms: drafting from nothing asks for some text', async ({ page }) => {
  await open(page, '/new');
  const draft = page.getByRole('button', { name: 'Draft with AI' });
  await expect(draft).toBeEnabled();
  await page.getByRole('button', { name: 'Write it by hand' }).focus();
  await draft.click();
  await expect(page.getByRole('alert')).toHaveText('Type or paste something to draft from.');
  await expect(page.getByLabel('What you have')).toBeFocused();
});

test('dialogs: Escape asks before dropping what was typed, and Cancel does not', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('button', { name: 'New collection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New collection' });

  // Nothing entered yet: Escape just closes.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'New collection' }).click();
  await dialog.getByLabel('Name').fill('Graphs');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('dialog', { name: 'Discard what you entered?' });
  await expect(ask.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(ask).toBeHidden();
  await expect(dialog.getByLabel('Name')).toHaveValue('Graphs');
  await expect(dialog.getByLabel('Name')).toBeFocused();

  // A click on the backdrop asks as well.
  await page.mouse.click(5, 5);
  await ask.getByRole('button', { name: 'Discard changes' }).click();
  await expect(dialog).toBeHidden();

  // Cancel is the user's own answer already.
  await page.getByRole('button', { name: 'New collection' }).click();
  await dialog.getByLabel('Name').fill('Graphs');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(ask).toBeHidden();
});

test('toasts: the container is a live region before a toast arrives', async ({ page }) => {
  await open(page, '/');
  await expect(page.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-live', 'polite');
});

test('drawer: on a narrow screen it takes focus, keeps it, and closes on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await open(page, '/');
  const opener = page.getByRole('button', { name: 'Open navigation' });
  await opener.click();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar')).not.toHaveClass(/is-open/);
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(opener).toBeFocused();
});

test('links: menu items and palette results that go somewhere are links', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  const edit = page.getByRole('menuitem', { name: 'Edit details…' });
  await expect(edit).toHaveAttribute('href', /\/items\/[^/]+\/edit$/);
  await page.keyboard.press('Escape');

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search items, collections and commands' }).fill('tags');
  const option = page.getByRole('option', { name: 'Manage tags' });
  await expect(option.locator('a')).toHaveAttribute('href', '/tags');
  await option.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
});

test('headings: a page that only has a message to show still has an h1', async ({ page }) => {
  await open(page, '/no/such/page');
  await expect(page.getByRole('heading', { level: 1, name: 'There is nothing at this address' })).toBeVisible();
});

test('undo: a test case removed from a draft can be put back where it was', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Test cases' })).toBeVisible();

  const inputs = page.locator('section[aria-labelledby="cases-heading"]').getByLabel('Input (stdin)');
  await expect(inputs).toHaveCount(2);
  const first = await inputs.first().inputValue();
  await page.getByRole('button', { name: 'Remove case 1' }).click();
  await expect(inputs).toHaveCount(1);
  await page.getByRole('region', { name: 'Notifications' }).getByRole('button', { name: 'Undo' }).click();
  await expect(inputs).toHaveCount(2);
  await expect(inputs.first()).toHaveValue(first);
});

test('assumptions: each is a checkbox named by its own text, ticked from anywhere on the line', async ({ page }) => {
  await open(page, '/new');
  await page.getByLabel('What you have').fill('two sum — array of ints and a target, return the two indices that add up to it. O(n)?');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  const line = page.locator('.assumptions-list li').first();
  const text = (await line.innerText()).trim();
  const box = line.getByRole('checkbox');
  await expect(box).toHaveAccessibleName(text);
  await line.getByText(text).click();
  await expect(box).toBeChecked();
  await expect(box).toHaveAccessibleName(text);
});

test('AI activity: a row says which column each of its values belongs to', async ({ page }) => {
  await open(page, '/settings/ai-activity');
  const row = page.getByRole('list', { name: 'Requests' }).getByRole('button').first();
  await expect(row).toHaveAccessibleName(/Provider: .+Model: .+Tokens in: .+Tokens out: .+Time: .+When: /);
});

test('motion: a closing dialog plays its exit out of reach, then goes', async ({ page }) => {
  await open(page, '/');
  const opener = page.getByRole('button', { name: 'New collection' });
  await opener.click();
  await expect(page.getByRole('dialog', { name: 'New collection' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Still on screen for its exit, but inert, hidden from assistive technology, and focus is already back.
  const closing = await page.evaluate(() => {
    const backdrop = document.querySelector('.dialog-backdrop');
    return backdrop && { closing: backdrop.classList.contains('is-closing'), inert: backdrop.hasAttribute('inert'), hidden: backdrop.getAttribute('aria-hidden') };
  });
  expect(closing).toEqual({ closing: true, inert: true, hidden: 'true' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
});

test('reduced motion: dialogs and menus close at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/');
  await page.getByRole('button', { name: 'New collection' }).click();
  await expect(page.getByRole('dialog', { name: 'New collection' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.locator('.dialog-backdrop').count()).toBe(0);

  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.locator('.popover').count()).toBe(0);
});

test('motion: the tab underline is one indicator that follows the selected tab', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  const tabs = page.locator('.itembar-tabs');
  const placed = () =>
    tabs.evaluate((el) => {
      const selected = el.querySelector<HTMLElement>('.tab.is-selected');
      return { at: el.style.getPropertyValue('--indicator-x'), selected: selected ? `${selected.offsetLeft}px` : null };
    });
  await expect(tabs).toHaveAttribute('data-indicator', '');
  let p = await placed();
  expect(p.at).toBe(p.selected);
  await tabs.getByRole('link', { name: /Test cases/ }).click();
  await expect(tabs.getByRole('link', { name: /Test cases/ })).toHaveClass(/is-selected/);
  p = await placed();
  expect(p.at).toBe(p.selected);
  expect(p.at).not.toBe('0px');
});

test('sidebar: a long nested collection name truncates, and every count stays inside the sidebar', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('button', { name: 'Actions for Interview prep' }).click();
  await page.getByRole('menuitem', { name: 'New collection inside…' }).click();
  const dialog = page.getByRole('dialog', { name: /New collection/ });
  const name = 'A collection with a name far too long to fit in the sidebar';
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('link', { name })).toBeVisible();

  const overflow = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('.sidebar .nav-count, .sidebar .nav-more')]
      .filter((el) => el.getBoundingClientRect().right > sidebar.right)
      .map((el) => el.closest('.nav-item')?.textContent);
  });
  expect(overflow).toEqual([]);
});

test('focus: a menu row reached with the keyboard has a ring, so it differs from the row under the pointer', async ({ page }) => {
  await open(page, '/');
  const sort = page.getByRole('button', { name: /^Sort/ });
  await sort.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Sort by' });
  await expect(menu).toBeVisible();
  // The sort in effect is a checked choice, and the menu opens on it.
  const current = menu.getByRole('menuitemradio', { name: 'Last updated', checked: true });
  await expect(current).toBeFocused();
  await expect(current).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('ArrowDown');
  await expect(current).toHaveCSS('outline-style', 'none');
});

test('focus: the ring on a tag chip in a library row is not cut off', async ({ page }) => {
  await open(page, '/');
  // Shown: a page still hidden while it loads (lib/boot.ts) cannot take focus.
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  const chip = page.locator('.item-tags .chip').first();
  await chip.focus();
  await expect(chip).toHaveCSS('outline-offset', '-2px');
});

test('reduced motion: the reader jumps to a heading instead of scrolling smoothly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/');
  await page.getByRole('link', { name: 'Consistent Hashing' }).click();
  await expect(page.getByRole('region', { name: 'Reading', exact: true })).toHaveCSS('scroll-behavior', 'auto');
});

test('toasts: a toast stays while the pointer is on it, so its Undo cannot slip away', async ({ page }) => {
  await page.clock.install();
  await open(page, '/');
  await page.getByRole('button', { name: 'New collection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New collection' });
  await dialog.getByLabel('Name').fill('Graphs');
  await dialog.getByRole('button', { name: /^Create/ }).click();
  const toast = page.locator('.toast', { hasText: 'Created “Graphs”' });
  await expect(toast).toBeVisible();
  await toast.hover();
  await page.clock.runFor(15_000);
  await expect(toast).toBeVisible();
  await page.mouse.move(5, 5);
  await page.clock.runFor(15_000);
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('menus: a choice in effect is marked by a check, not by a background', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('button', { name: /^Sort/ }).click();
  const menu = page.getByRole('menu', { name: 'Sort by' });
  const current = menu.getByRole('menuitemradio', { name: 'Last updated' });
  await expect(current).toHaveAttribute('aria-checked', 'true');
  // Choices without icons of their own carry the check in the icon column.
  await expect(current.locator('.menu-item-icon .menu-item-check')).toHaveCount(1);
  await expect(menu.getByRole('menuitemradio', { name: 'Title' }).locator('.menu-item-check')).toHaveCount(0);
  await expect(menu).not.toContainText('current');
  const plain = await menu.getByRole('menuitemradio', { name: 'Title' }).evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(current).toHaveCSS('background-color', plain);
  await page.keyboard.press('Escape');

  // Choices with icons keep them, and the check goes at the end.
  await page.getByRole('button', { name: /^Theme/ }).click();
  const theme = page.getByRole('menuitemradio', { name: 'System' });
  await expect(theme).toHaveAttribute('aria-checked', 'true');
  await expect(theme.locator('.menu-item-icon svg')).toHaveCount(1);
  await expect(theme.locator('.menu-item-icon .menu-item-check')).toHaveCount(0);
  await expect(theme.locator('.menu-item-end .menu-item-check')).toHaveCount(1);
});

test('layout: selecting a row or setting a filter moves no row and no filter button', async ({ page }) => {
  await open(page, '/');
  const firstRow = page.locator('.item-row').first();
  const bar = page.getByRole('search', { name: 'Filter items' });
  const difficulty = bar.getByRole('button', { name: /^Difficulty/ });
  const top = async () => (await firstRow.boundingBox())?.y;
  const left = async () => (await difficulty.boundingBox())?.x;
  // The real rows, not the placeholders of a first load.
  await expect(firstRow.getByRole('checkbox')).toBeVisible();
  const rowTop = await top();
  const difficultyLeft = await left();

  await firstRow.getByRole('checkbox').check();
  await expect(page.getByRole('toolbar', { name: 'Actions for selected items' })).toBeVisible();
  expect(await top()).toBe(rowTop);
  await page.keyboard.press('Escape');
  await expect(bar).toBeVisible();

  await bar.getByRole('button', { name: /^Status/ }).click();
  await page.getByRole('dialog', { name: 'Status' }).getByText('To do').click();
  await expect(page).toHaveURL(/status=todo/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.item-head-label')).toHaveText(/^\d+ of 25$/);
  expect(await top()).toBe(rowTop);
  expect(await left()).toBe(difficultyLeft);
});

/** WCAG contrast ratio of two opaque `rgb(…)` colours, as getComputedStyle gives them. */
function contrast(a: string, b: string): number {
  const luminance = (rgb: string) => {
    const [r = 0, g = 0, bl = 0] = (rgb.match(/[\d.]+/g) ?? []).map(Number).map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`hover: a hovered library row stands out from the others (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, '/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const rows = page.locator('.item-row');
    // A row has no fill of its own at rest, so it shows the list's.
    const resting = await page.locator('.item-list-wrap').evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(rows.nth(1)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await rows.nth(0).hover();
    const hovered = await rows.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor);
    // Different, and by enough to see: 1.02:1, the old step in the dark theme, was not.
    expect(contrast(hovered, resting)).toBeGreaterThan(1.1);
  });
}

test('sidebar: the current view and a hovered one look different', async ({ page }) => {
  await open(page, '/');
  const nav = page.getByRole('complementary', { name: 'Navigation' });
  const active = nav.getByRole('link', { name: /^All items/ });
  await expect(active).toHaveAttribute('aria-current', 'page');
  const problems = nav.getByRole('link', { name: /^Problems/ });
  await problems.hover();
  const hovered = await problems.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(hovered).not.toBe('rgba(0, 0, 0, 0)');
  await expect(active).not.toHaveCSS('background-color', hovered);
});

test('layout: the statement pane stops growing where the statement does', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1000 });
  await open(page, '/');
  await page.getByRole('link', { name: 'Longest Substring Without Repeating Characters' }).click();
  const handle = page.getByRole('separator', { name: 'Resize statement and editor' });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(1800, box.y + 200, { steps: 8 });
  await page.mouse.up();
  const width = async (selector: string) => (await page.locator(selector).first().boundingBox())!.width;
  // Dragged well past it, the pane holds the statement at its widest and no more.
  expect(await width('.split-horizontal > .split-pane')).toBeLessThanOrEqual(880);
  expect(await width('.statement')).toBe(820);
});
