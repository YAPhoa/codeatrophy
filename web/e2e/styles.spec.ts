import { expect, test, type Page } from '@playwright/test';
import { open } from './support';

// The default style is chosen from a radio group of cards on the Writing
// styles page and saved at once; editing and deleting a style happen in its
// dialog. The seed has "LeetCode style" (the default) and "Terse contest style".

const group = (page: Page) => page.getByRole('radiogroup', { name: 'Default style' });

/** The default the mock server holds, read past the page's cache: a preset's name, or null. */
const storedDefault = (page: Page) =>
  page.evaluate(async () => {
    const mock = (window as unknown as { __codeatrophyMock: { fetch: (path: string) => Promise<Response> } }).__codeatrophyMock;
    const { items } = (await (await mock.fetch('/api/v1/styles')).json()) as { items: { name: string; isDefault: boolean }[] };
    return items.find((s) => s.isDefault)?.name ?? null;
  });

test('styles: picking a radio makes it the default, and Built-in clears it', async ({ page }) => {
  await open(page, '/settings/styles');
  const radios = group(page).getByRole('radio');
  await expect(radios).toHaveCount(3);
  await expect(group(page).getByRole('radio', { name: 'LeetCode style' })).toBeChecked();

  // A click anywhere on the card picks it: the name's label covers the card.
  await group(page).locator('.style-choice', { hasText: 'Terse contest style' }).click({ position: { x: 300, y: 40 } });
  await expect(group(page).getByRole('radio', { name: 'Terse contest style' })).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  expect(await storedDefault(page)).toBe('Terse contest style');

  // It holds when the page is loaded again.
  const nav = page.getByRole('navigation', { name: 'Settings' });
  await nav.getByRole('link', { name: 'Preferences' }).click();
  await nav.getByRole('link', { name: 'Writing styles' }).click();
  await expect(group(page).getByRole('radio', { name: 'Terse contest style' })).toBeChecked();

  // Arrow keys move the choice the native way, and saving follows. The
  // default is listed first when the page opens: Built-in, Terse, LeetCode.
  await expect(group(page).locator('label')).toHaveText(['Built-in conventions', 'Terse contest style', 'LeetCode style']);
  await group(page).getByRole('radio', { name: 'Terse contest style' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(group(page).getByRole('radio', { name: 'LeetCode style' })).toBeChecked();
  await expect.poll(() => storedDefault(page)).toBe('LeetCode style');

  await group(page).getByRole('radio', { name: 'Built-in conventions' }).check();
  await expect(group(page).getByRole('radio', { name: 'Built-in conventions' })).toBeChecked();
  await expect.poll(() => storedDefault(page)).toBeNull();
});

test('styles: editing does not change the choice, and a style is deleted from its dialog', async ({ page }) => {
  await open(page, '/settings/styles');
  await group(page).getByRole('button', { name: 'Edit Terse contest style' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit style' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(group(page).getByRole('radio', { name: 'LeetCode style' })).toBeChecked();
  expect(await storedDefault(page)).toBe('LeetCode style');

  // The old per-card buttons are gone.
  await expect(page.getByRole('button', { name: /Make default|Unset default|^Delete / })).toHaveCount(0);

  await group(page).getByRole('button', { name: 'Edit LeetCode style' }).click();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete the style “LeetCode style”?' });
  await confirm.getByRole('button', { name: 'Delete style' }).click();
  await expect(page.getByText('Deleted “LeetCode style”')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(group(page).getByRole('radio')).toHaveCount(2);
  // It was the default, so now none is.
  await expect(group(page).getByRole('radio', { name: 'Built-in conventions' })).toBeChecked();
  expect(await storedDefault(page)).toBeNull();
});

test('styles: with none saved, the example card shows instead of the list', async ({ page }) => {
  await open(page, '/settings/styles', 'fast,no-styles');
  await expect(page.getByText('No styles yet')).toBeVisible();
  await expect(page.getByRole('radiogroup')).toHaveCount(0);
  // The system prompt is there all the same.
  await expect(page.getByRole('group', { name: 'System prompt' })).toBeVisible();
});
