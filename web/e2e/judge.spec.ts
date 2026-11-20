import { expect, test } from '@playwright/test';
import { open, writeCode } from './support';

// What the solve page and the test cases make of each verdict, and of a judge
// that is down or not configured. The mock judge reads its verdict from a
// marker in the source (MOCK:TLE, MOCK:CE, …).

const LONGEST = 'Longest Substring Without Repeating Characters';
const ACCEPTED = 'import sys\n\nprint(len(sys.stdin.readline()))\n';

test('verdicts: each failing verdict is named; a compile error shows the compiler\'s output, a crash its error output', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('link', { name: LONGEST }).click();
  const panel = page.getByRole('tabpanel', { name: 'Result' });
  const verdict = panel.locator('.result-verdict');
  for (const [marker, label] of [
    ['TLE', 'Time limit exceeded'],
    ['MLE', 'Memory limit exceeded'],
    ['IE', 'Judge error'],
    ['RE', 'Runtime error'],
    ['CE', 'Compile error'],
  ] as const) {
    await writeCode(page, `${ACCEPTED}# MOCK:${marker}\n`);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(verdict).toHaveText(label);
    if (marker === 'IE') await expect(panel.getByText('The judge could not complete this run')).toBeVisible();
    if (marker === 'RE') await expect(panel.getByText('Error output (stderr)')).toBeVisible();
    if (marker === 'CE') {
      await expect(panel.getByText('Compiler output', { exact: true })).toBeVisible();
      await expect(panel.locator('.compile-output')).not.toBeEmpty();
    }
  }
});

test('judge down: a submission ends in a judge error, "Verify all" says why, and generated cases come back unverified', async ({ page }) => {
  await open(page, '/', 'fast,judge-down');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await writeCode(page, ACCEPTED);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Result' });
  await expect(panel.locator('.result-verdict')).toHaveText('Judge error');
  await expect(panel.getByText('The judge could not complete this run')).toBeVisible();

  const sections = page.getByRole('navigation', { name: 'Problem sections' });
  await sections.getByRole('link', { name: /^Test cases/ }).click();
  await page.getByRole('button', { name: 'Verify all' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Verification could not run' })).toContainText('No judge engine is configured, or it cannot be reached right now.');

  await page.getByRole('link', { name: /Generate/ }).first().click();
  await page.getByLabel('How many').fill('2');
  await page.getByRole('button', { name: 'Generate test cases', exact: true }).click();
  await expect(page.getByText('The outputs could not be verified')).toBeVisible();
  await expect(page.locator('.proposal-case').getByText('unverified')).toHaveCount(2);
});

test('no judge: there is nothing to run code on, and the solve page says so', async ({ page }) => {
  await open(page, '/', 'fast,no-judge');
  await page.getByRole('link', { name: 'Two Sum', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /solution code/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0);
  await page.locator('.drawer-bar').getByText('Running code is not available here').click();
  await expect(page.getByRole('heading', { name: 'Running code is not available here' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Judge status' })).toHaveAttribute('href', '/settings/judge');

  // So does the judge's page in Settings.
  await page.getByRole('link', { name: 'Judge status' }).click();
  await expect(page.getByText('No judge engine is configured')).toBeVisible();
});
