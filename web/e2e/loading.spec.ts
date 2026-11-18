import { expect, test, type Page } from '@playwright/test';
import { loadingRecord, open, recordLoading } from './support';

// A load that is quick shows nothing as loading: the screen simply fades in.
// Only a slow one shows an indicator, and only once 400ms have passed.

const twoSum = (page: Page) => page.getByRole('link', { name: 'Two Sum', exact: true });

/** The workspace of a problem, with its editor ready. */
async function inWorkspace(page: Page) {
  await expect(page.locator('.workspace-body')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /solution code/i })).toBeVisible();
}

test('loading: a slow load shows its indicator after 400ms, then the screen fades in', async ({ page }) => {
  await recordLoading(page);
  // Every request takes a second.
  await open(page, '/', 'slow');
  await expect(twoSum(page)).toBeVisible({ timeout: 10_000 });
  let record = await loadingRecord(page);
  // The app is shown by the boot's deadline, with "Connecting…" coming in a little later.
  const connecting = record.indicators.find((i) => i.what === 'Connecting to Codeatrophy…');
  expect(connecting).toBeDefined();
  expect(connecting!.shownAt - connecting!.mountedAt).toBeGreaterThanOrEqual(395);
  expect(connecting!.shownAt - connecting!.mountedAt).toBeLessThan(800);
  // The shell arrives after it, fading in whole.
  const shell = record.entrances.find((e) => e.what.startsWith('div.shell'));
  expect(shell?.at).toBeGreaterThan(connecting!.shownAt);

  await twoSum(page).click();
  await inWorkspace(page);
  await page.waitForTimeout(300);
  record = await loadingRecord(page);
  const opening = record.indicators.find((i) => i.what === 'Loading…' && i.shownAt > shell!.at);
  expect(opening).toBeDefined();
  expect(opening!.shownAt - opening!.mountedAt).toBeGreaterThanOrEqual(395);
  expect(opening!.shownAt - opening!.mountedAt).toBeLessThan(800);
  // The workspace still fades in once its data is in.
  expect(record.entrances.find((e) => e.what === 'div.workspace-body')?.at).toBeGreaterThan(opening!.shownAt);
});

test('loading: resting on a row loads the item, so opening it shows no loading state', async ({ page }) => {
  await open(page, '/');
  await expect(twoSum(page)).toBeVisible();
  const id = (await twoSum(page).getAttribute('href'))!.split('/').pop()!;
  const requests = () => page.evaluate(() => (window as unknown as { __codeatrophyMock: { requests: string[] } }).__codeatrophyMock.requests.splice(0));
  const detail = (list: string[]) => list.filter((r) => /^GET \/items\/[^/?]+(\/testcases)?$/.test(r));
  await page.waitForTimeout(300);
  await requests();

  // Sweeping the pointer down the list asks for nothing.
  const box = (await page.locator('.item-list').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 5);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 5, { steps: 25 });
  await page.mouse.move(box.x - 40, box.y + box.height - 5);
  await page.waitForTimeout(200);
  expect(detail(await requests())).toEqual([]);

  // Resting on one loads it and its test cases, once.
  await twoSum(page).hover();
  await page.waitForTimeout(300);
  expect(detail(await requests()).sort()).toEqual([`GET /items/${id}`, `GET /items/${id}/testcases`]);

  await page.evaluate(() => {
    const w = window as unknown as { __mountedLoading: number };
    w.__mountedLoading = 0;
    new MutationObserver((changes) => {
      for (const change of changes)
        for (const node of change.addedNodes) if (node instanceof Element && (node.matches('.page-state') || node.querySelector('.page-state'))) w.__mountedLoading++;
    }).observe(document, { childList: true, subtree: true });
  });
  await twoSum(page).click();
  await inWorkspace(page);
  expect(await page.evaluate(() => (window as unknown as { __mountedLoading: number }).__mountedLoading)).toBe(0);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a slow load still waits 400ms to show as loading, and the screen appears without a fade', async ({ page }) => {
    await recordLoading(page);
    await open(page, '/', 'slow');
    await expect(twoSum(page)).toBeVisible({ timeout: 10_000 });
    await twoSum(page).click();
    await expect(page.locator('.workspace-body')).toBeVisible();
    expect(await page.locator('.workspace-body').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await inWorkspace(page);
    const record = await loadingRecord(page);
    expect(record.indicators.length).toBeGreaterThanOrEqual(2);
    for (const i of record.indicators) expect(i.shownAt - i.mountedAt).toBeGreaterThanOrEqual(395);
    // No screen fades in. (The app's reveal flips at once: base.css cuts every duration to nil.)
    expect(record.entrances.filter((e) => e.what !== 'div#root.')).toEqual([]);
  });
});
