import { expect, test, type Page } from '@playwright/test';
import { choose, mockApi, open, writeCode } from './support';

// The code written on a problem is kept on the server as one working copy
// per language. The mock keeps them across a reload, as the server does.

const TWO_SUM = '11111111-1111-4111-8111-000000000001';
/** Seeded with past submissions. */
const LONGEST_SUBSTRING = '11111111-1111-4111-8111-000000000005';

const editor = (page: Page) => page.locator('.editor-host .cm-content');
const languageSelect = (page: Page) => page.getByRole('combobox', { name: 'Language' });
const saveStatus = (page: Page) => page.locator('.editor-save-status [role="status"]');

/** The working copies the mock server holds for a problem, Two Sum unless named, newest first. */
const copies = async (page: Page, itemId = TWO_SUM) =>
  (await mockApi<{ items: { language: string; source: string }[] }>(page, `/items/${itemId}/workspace`)).items.map((w) => [w.language, w.source]);

/** The localStorage keys of edits not confirmed by the server. */
const unsaved = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('codeatrophy:unsaved:')).sort());

/** From the next page load on, record the editor's text on every frame (`seenCode`). */
async function sampleEditor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { seenCode: string[] }).seenCode = seen;
    const sample = () => {
      const el = document.querySelector('.editor-host .cm-content, .editor-host .code-editor-fallback');
      if (el) seen.push(el.textContent ?? '');
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

const seenCode = (page: Page) => page.evaluate(() => (window as unknown as { seenCode: string[] }).seenCode);

test('workspace: code typed is on the server, and a reload shows it from the first frame', async ({ page }) => {
  await open(page, `/items/${TWO_SUM}`);
  await choose(languageSelect(page), /^Python/);
  await writeCode(page, 'print("kept on the server")');
  await expect.poll(() => copies(page)).toEqual([['python', 'print("kept on the server")']]);
  await expect.poll(() => unsaved(page)).toEqual([]);
  // No "Not saved" while saving works.
  await expect(saveStatus(page)).toHaveText('');

  await sampleEditor(page);
  await page.reload();
  await expect(editor(page)).toContainText('kept on the server');
  await expect(languageSelect(page)).toContainText('Python');
  const seen = await seenCode(page);
  expect(seen.length).toBeGreaterThan(0);
  // Never a frame of starter code before the saved code.
  expect(seen.filter((text) => !text.includes('kept on the server'))).toEqual([]);
});

test('workspace: switching language and back finds each language\'s code, here and after a reload', async ({ page }) => {
  await open(page, `/items/${TWO_SUM}`);
  await choose(languageSelect(page), /^Python/);
  await writeCode(page, 'print("python copy")');
  await choose(languageSelect(page), /^C\+\+/);
  // C++ has no copy yet: its starter code.
  await expect(editor(page)).not.toContainText('python copy');
  await expect(editor(page)).toContainText('#include');
  await writeCode(page, '// cpp copy');
  await choose(languageSelect(page), /^Python/);
  await expect(editor(page)).toHaveText('print("python copy")');
  await choose(languageSelect(page), /^C\+\+/);
  await expect(editor(page)).toHaveText('// cpp copy');
  await expect.poll(() => copies(page)).toEqual([
    ['cpp', '// cpp copy'],
    ['python', 'print("python copy")'],
  ]);

  // It opens on the language written in last.
  await page.reload();
  await expect(languageSelect(page)).toContainText('C++');
  await expect(editor(page)).toHaveText('// cpp copy');
  await choose(languageSelect(page), /^Python/);
  await expect(editor(page)).toHaveText('print("python copy")');
});

test('workspace: Reset goes back to the starter code and deletes the copy, for good', async ({ page }) => {
  await open(page, `/items/${TWO_SUM}`);
  await choose(languageSelect(page), /^Python/);
  const starter = await editor(page).textContent();
  expect(starter).toBeTruthy();
  await writeCode(page, 'print("to be reset")');
  await expect.poll(() => copies(page)).toEqual([['python', 'print("to be reset")']]);

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset code' }).click();
  await expect(editor(page)).toHaveText(starter!);
  await expect.poll(() => copies(page)).toEqual([]);
  await expect.poll(() => unsaved(page)).toEqual([]);

  await page.reload();
  await expect(languageSelect(page)).toContainText('Python');
  await expect(editor(page)).toHaveText(starter!);
  expect(await copies(page)).toEqual([]);
});

test('workspace: code an older version kept in this browser is uploaded once where the server has none, and removed', async ({ page }) => {
  await page.addInitScript((id) => {
    // Only before the first load: what the app removes must stay removed.
    if (sessionStorage.getItem('legacy-seeded')) return;
    sessionStorage.setItem('legacy-seeded', '1');
    localStorage.setItem(`codeatrophy:code:${id}:go`, 'package main // from before');
    localStorage.setItem(`codeatrophy:code:${id}:python`, 'print("older, loses")');
  }, TWO_SUM);
  await open(page, '/');
  await mockApi(page, `/items/${TWO_SUM}/workspace/python`, { method: 'PUT', body: { source: 'print("on the server")' } });
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();

  // The server's copy wins where there is one.
  await expect(editor(page)).toHaveText('print("on the server")');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('codeatrophy:code:')))).toEqual([]);
  await expect.poll(() => copies(page)).toEqual([
    ['go', 'package main // from before'],
    ['python', 'print("on the server")'],
  ]);
  await choose(languageSelect(page), /^Go/);
  await expect(editor(page)).toHaveText('package main // from before');
  // Uploaded once: nothing more goes up for it.
  const puts = await page.evaluate(() => (window as unknown as { __codeatrophyMock: { requests: string[] } }).__codeatrophyMock.requests.filter((r) => r.startsWith('PUT') && r.endsWith('/workspace/go')));
  expect(puts).toHaveLength(1);
  expect(await unsaved(page)).toEqual([]);
});

test('workspace: an unsaved edit wins only while the server copy is the one it was based on', async ({ page }) => {
  await open(page, '/');
  type Copy = { updatedAt: string };
  await mockApi(page, `/items/${TWO_SUM}/workspace/python`, { method: 'PUT', body: { source: 'print("written elsewhere since")' } });
  const cpp = await mockApi<Copy>(page, `/items/${TWO_SUM}/workspace/cpp`, { method: 'PUT', body: { source: '// on the server' } });
  await page.evaluate(
    ({ id, cppAt }) => {
      // Based on a Python copy older than the server's: the server's wins.
      localStorage.setItem(`codeatrophy:unsaved:${id}:python`, JSON.stringify({ source: 'print("stale")', base: '2020-01-01T00:00:00Z' }));
      // Based on the C++ copy the server still has: the edit wins, and is sent.
      localStorage.setItem(`codeatrophy:unsaved:${id}:cpp`, JSON.stringify({ source: '// not saved before', base: cppAt }));
    },
    { id: TWO_SUM, cppAt: cpp.updatedAt },
  );
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();

  await expect(languageSelect(page)).toContainText('C++');
  await expect(editor(page)).toHaveText('// not saved before');
  await expect.poll(() => copies(page)).toEqual([
    ['cpp', '// not saved before'],
    ['python', 'print("written elsewhere since")'],
  ]);
  await expect.poll(() => unsaved(page)).toEqual([]);
  await choose(languageSelect(page), /^Python/);
  await expect(editor(page)).toHaveText('print("written elsewhere since")');
});

test('workspace: a save that fails says so, keeps the edit through a reload, and sends it once saving works', async ({ page }) => {
  await open(page, `/items/${TWO_SUM}`, 'fast,workspace-fail');
  await choose(languageSelect(page), /^Python/);
  await writeCode(page, 'print("not saved yet")');
  await expect(saveStatus(page)).toHaveText('Not saved');
  expect(await unsaved(page)).toEqual([`codeatrophy:unsaved:${TWO_SUM}:python`]);
  expect(await copies(page)).toEqual([]);

  // The scenario lasts for the tab: after the reload, saving still fails.
  await sampleEditor(page);
  await page.reload();
  await expect(editor(page)).toHaveText('print("not saved yet")');
  expect((await seenCode(page)).filter((text) => text !== 'print("not saved yet")')).toEqual([]);
  await expect(saveStatus(page)).toHaveText('Not saved');

  // The server takes writes again; coming back online sends the edit, once.
  const before = await page.evaluate(() => {
    const mock = (window as unknown as { __codeatrophyMock: { requests: string[]; db: { workspaceWritesFail: boolean } } }).__codeatrophyMock;
    const from = mock.requests.length;
    mock.db.workspaceWritesFail = false;
    window.dispatchEvent(new Event('online'));
    return from;
  });
  await expect.poll(() => copies(page)).toEqual([['python', 'print("not saved yet")']]);
  await expect(saveStatus(page)).toHaveText('');
  await expect.poll(() => unsaved(page)).toEqual([]);
  // Past the save delay: nothing more was sent.
  await page.waitForTimeout(1200);
  const puts = await page.evaluate(
    (from) => (window as unknown as { __codeatrophyMock: { requests: string[] } }).__codeatrophyMock.requests.slice(from).filter((r) => r.startsWith('PUT')),
    before,
  );
  expect(puts).toEqual([`PUT /items/${TWO_SUM}/workspace/python`]);
});

test('workspace: the code of a past submission, loaded into the editor, is saved like an edit', async ({ page }) => {
  await open(page, `/items/${LONGEST_SUBSTRING}`);
  await choose(languageSelect(page), /^Python/);
  await writeCode(page, 'print("mine")');
  await expect.poll(() => copies(page, LONGEST_SUBSTRING)).toEqual([['python', 'print("mine")']]);

  await page.getByRole('tab', { name: /Submissions/ }).click();
  await page.getByRole('tabpanel', { name: 'Submissions' }).locator('.history-row').first().click();
  await page.getByRole('button', { name: 'Load this code' }).click();
  await expect(editor(page)).not.toHaveText('print("mine")');
  const loaded = await mockApi<{ items: { id: string }[] }>(page, `/items/${LONGEST_SUBSTRING}/submissions?mode=submit`);
  const { language, source } = await mockApi<{ language: string; source: string }>(page, `/submissions/${loaded.items[0]!.id}`);
  // In its own language, which the editor switched to; the code written before stays that language's.
  await expect.poll(async () => (await copies(page, LONGEST_SUBSTRING))[0]).toEqual([language, source]);
  if (language !== 'python') expect(await copies(page, LONGEST_SUBSTRING)).toContainEqual(['python', 'print("mine")']);
});
