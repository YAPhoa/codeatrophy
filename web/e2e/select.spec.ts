import { expect, test } from '@playwright/test';
import { open } from './support';

// Dropdowns are the app's own (ui/Select.tsx), not the browser's: a
// combobox button and a listbox drawn like the app's menus, worked as a
// native select is with the pointer and the keyboard.

const COLLECTIONS = ['Interview prep', 'Arrays & hashing', 'Dynamic programming', 'Graphs', 'Systems reading', 'Databases', 'Distributed systems', 'Weekly practice'];

test('select: the Export page’s collection comes from the app’s own list, nested ones indented and the choice checked', async ({ page }) => {
  await open(page, '/settings/export?scope=collection');
  const select = page.getByRole('combobox', { name: 'Collection' });
  await expect(select).toHaveText('Interview prep');
  await expect(select).toHaveAccessibleDescription(/^Includes 3 nested collections\./);
  await expect(select).toHaveAttribute('aria-expanded', 'false');

  await select.click();
  const list = page.getByRole('listbox', { name: 'Collection' });
  await expect(list).toBeVisible();
  await expect(select).toHaveAttribute('aria-expanded', 'true');
  await expect(select).toBeFocused();
  const options = list.getByRole('option');
  // Plain names, nested ones indented by the row's padding rather than spaces.
  await expect(options).toHaveText(COLLECTIONS);
  const indent = (name: string) => list.getByRole('option', { name, exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(await indent('Arrays & hashing')).toBe((await indent('Interview prep')) + 16);
  expect(await indent('Systems reading')).toBe(await indent('Interview prep'));
  // The choice is selected and checked, and it alone.
  await expect(list.getByRole('option', { selected: true })).toHaveText('Interview prep');
  await expect(list.locator('.menu-item-check')).toHaveCount(1);
  await expect(options.first().locator('.menu-item-check')).toBeVisible();
  // As wide as its button, under it, once it has grown in.
  await list.evaluate((el) => Promise.all(el.closest('.popover')!.getAnimations().map((a) => a.finished)));
  const [listBox, selectBox] = [(await list.boundingBox())!, (await select.boundingBox())!];
  expect(Math.abs(listBox.x - selectBox.x)).toBeLessThan(2);
  expect(listBox.width).toBeGreaterThanOrEqual(selectBox.width - 2);
  expect(listBox.y).toBeGreaterThan(selectBox.y + selectBox.height - 1);

  // The keyboard moves the active option and picks it; focus stays on the button.
  await page.keyboard.press('ArrowDown');
  await expect(select).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id'))!);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(select).toHaveText('Dynamic programming');
  await expect(select).toBeFocused();
  await expect(select).toHaveAccessibleDescription(/^\d+ items? in total\./);

  // Escape puts the list away without picking.
  await page.keyboard.press('ArrowDown');
  await expect(list).toBeVisible();
  await expect(list.getByRole('option', { selected: true })).toHaveText('Dynamic programming');
  await page.keyboard.press('End');
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(select).toHaveText('Dynamic programming');
  await expect(select).toBeFocused();

  // Typing jumps to an option: closed, it chooses it; open, it moves there.
  await page.keyboard.type('w');
  await expect(select).toHaveText('Weekly practice');
  await expect(list).toBeHidden();
  await page.keyboard.press('Enter');
  await page.keyboard.type('dis');
  await expect(select).toHaveAttribute('aria-activedescendant', (await options.nth(6).getAttribute('id'))!);
  await page.keyboard.press('Enter');
  await expect(select).toHaveText('Distributed systems');

  // The pointer picks too.
  await select.click();
  await list.getByRole('option', { name: 'Graphs' }).click();
  await expect(list).toBeHidden();
  await expect(select).toHaveText('Graphs');

  // Its label moves focus to it, as a label does for a native select, without opening it.
  await page.getByRole('heading', { name: 'Export a bundle' }).click();
  await expect(select).not.toBeFocused();
  await page.locator('label', { hasText: /^Collection$/ }).click();
  await expect(select).toBeFocused();
  await expect(select).toHaveAttribute('aria-expanded', 'false');
});

test('select: in a dialog its list is on top, and Escape or Tab put away the list and leave the dialog open', async ({ page }) => {
  await open(page, '/tags');
  await page.getByRole('button', { name: /^Merge .* into another tag$/ }).first().click();
  const dialog = page.getByRole('dialog');
  const select = dialog.getByRole('combobox', { name: 'Target tag' });
  await select.click();
  const list = page.getByRole('listbox', { name: 'Target tag' });
  await expect(list).toBeVisible();
  // Over the dialog where they overlap, and past its edge where it runs on.
  const box = (await list.boundingBox())!;
  const hit = (x: number, y: number) => page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[role=listbox]'), [x, y]);
  expect(await hit(box.x + 40, box.y + 12)).toBe(true);
  expect(await hit(box.x + 40, box.y + box.height - 12)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(select).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(list).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(list).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(select).not.toBeFocused();

  await select.focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
