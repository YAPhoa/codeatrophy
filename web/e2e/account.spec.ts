import { expect, test, type Page } from '@playwright/test';
import { open } from './support';

// Settings › Account and the MCP tokens on Settings › MCP server, with sign-in
// on and the mock's account signed in (`?mock=signed-in`).

const SIGNED_IN = 'fast,signed-in';
const EMAIL = 'me@example.com';

/** The parts of the page's API mock (`window.__codeatrophyMock`) the tests read. */
interface Mock {
  db: { account: { password: string; mcpTokens: { token: string }[] } };
  requests: string[];
}
type MockWindow = { __codeatrophyMock: Mock };

const signInPage = (page: Page) => page.getByRole('heading', { level: 1, name: 'Sign in' });
const sessionList = (page: Page) => page.getByRole('region', { name: 'Account' }).getByRole('list', { name: 'Sessions' });
const sessionRow = (page: Page, text: string) => sessionList(page).getByRole('listitem').filter({ hasText: text });
const mockRequests = (page: Page, pattern: RegExp) =>
  page.evaluate((source) => (window as unknown as MockWindow).__codeatrophyMock.requests.filter((r) => new RegExp(source).test(r)).length, pattern.source);

test('the Account page is three cards: who is signed in, the password, the sessions', async ({ page }) => {
  await open(page, '/settings/account', SIGNED_IN);
  const section = page.getByRole('region', { name: 'Account' });
  await expect(section.getByText(`Signed in as ${EMAIL}.`)).toBeVisible();
  await expect(section.getByText('Everyone on this server shares the library.', { exact: false })).toBeVisible();
  await expect(section.getByRole('heading', { name: 'Change password' })).toBeVisible();
  await expect(section.getByLabel('Current password')).toHaveCount(0);
  await expect(section.getByLabel('New password', { exact: true })).toBeVisible();
  await expect(section.getByLabel('Repeat the new password')).toBeVisible();
  await expect(section.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(section.getByText('Other browsers stay signed in.')).toHaveCount(0);
  // The MCP tokens are on the MCP server page now.
  await expect(section.getByText('Tokens')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Create token' })).toHaveCount(0);
});

test('changing the password asks only for the new one, twice', async ({ page }) => {
  await open(page, '/settings/account', SIGNED_IN);
  const form = page.getByRole('form', { name: 'Change password' });
  const submit = form.getByRole('button', { name: 'Change password' });
  await expect(submit).toBeDisabled();

  await form.getByLabel('New password', { exact: true }).fill('battery staple');
  await form.getByLabel('Repeat the new password').fill('battery stapler');
  await submit.click();
  await expect(form.getByText('The passwords differ.')).toBeVisible();

  // The server's field error is shown under the field.
  await form.getByLabel('New password', { exact: true }).fill('short');
  await form.getByLabel('Repeat the new password').fill('short');
  await submit.click();
  await expect(form.getByText('Must be at least 8 characters.')).toBeVisible();

  await form.getByLabel('New password', { exact: true }).fill('battery staple');
  await form.getByLabel('Repeat the new password').fill('battery staple');
  await submit.click();
  await expect(page.getByText('Password changed. Other browsers signed in to this account were signed out.')).toBeVisible();
  await expect(form.getByLabel('New password', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => (window as unknown as MockWindow).__codeatrophyMock.db.account.password)).toBe('battery staple');
});

test('signing out this browser from the Account page asks first', async ({ page }) => {
  await open(page, '/settings/account', SIGNED_IN);
  const section = page.getByRole('region', { name: 'Account' });
  const dialog = page.getByRole('dialog', { name: 'Sign out of this browser?' });
  // Its own button, below the sessions: this browser's row has none.
  const button = section.getByRole('button', { name: 'Sign out', exact: true });

  // Cancel keeps you signed in.
  await button.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('You’ll stay signed in on your other browsers and devices.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(section.getByText(`Signed in as ${EMAIL}.`)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as MockWindow).__codeatrophyMock.requests.filter((r) => r === 'POST /auth/logout').length)).toBe(0);

  // Confirming signs out.
  await button.click();
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await expect(signInPage(page)).toBeVisible();
});

test('the Sessions card lists the browsers signed in, this one first', async ({ page }) => {
  await open(page, '/settings/account', SIGNED_IN);
  const rows = sessionList(page).getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Firefox on Linux');
  await expect(rows.nth(0)).toContainText('This browser');
  await expect(rows.nth(0)).toContainText('signed in 3 days ago · active just now');
  // This browser's row offers nothing: it is signed out with the Sign out button.
  await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
  await expect(rows.nth(1)).toContainText('Chrome on macOS');
  await expect(rows.nth(1)).toContainText('signed in 9 days ago · active 5 hr. ago');
  await expect(rows.nth(1).locator('time').first()).toHaveAttribute('title', /\d/);
  await expect(rows.nth(2)).toContainText('Safari on iPhone');
  for (const i of [1, 2]) {
    await expect(rows.nth(i)).not.toContainText('This browser');
    await expect(rows.nth(i).getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  }
});

test('revoking another browser asks first', async ({ page }) => {
  await open(page, '/settings/account', SIGNED_IN);
  const row = sessionRow(page, 'Chrome on macOS');
  const dialog = page.getByRole('dialog', { name: 'Revoke Chrome on macOS?' });

  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(dialog.getByText('That browser will need the password to sign in again.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();
  expect(await mockRequests(page, /^DELETE \/auth\/sessions\//)).toBe(0);

  await row.getByRole('button', { name: 'Revoke' }).click();
  await dialog.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Signed out Chrome on macOS')).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(sessionList(page).getByRole('listitem')).toHaveCount(2);
  // Still signed in here.
  await expect(sessionRow(page, 'This browser')).toBeVisible();
});

test('signing out the other browsers keeps this one', async ({ page }) => {
  await open(page, '/settings/account', SIGNED_IN);
  const section = page.getByRole('region', { name: 'Account' });
  const button = section.getByRole('button', { name: 'Sign out other browsers' });
  const dialog = page.getByRole('dialog', { name: 'Sign out other browsers?' });

  await button.click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(sessionList(page).getByRole('listitem')).toHaveCount(3);

  await button.click();
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Other browsers signed out')).toBeVisible();
  const rows = sessionList(page).getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('This browser');
  // With one session left there are no others to sign out.
  await expect(button).toHaveCount(0);
});

test('the sidebar’s Sign out asks first too', async ({ page }) => {
  await open(page, '/', SIGNED_IN);
  const button = page.getByRole('button', { name: `Sign out (${EMAIL})` });
  const dialog = page.getByRole('dialog', { name: 'Sign out of this browser?' });

  await button.click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeVisible();
  await expect(signInPage(page)).toHaveCount(0);

  await button.click();
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await expect(signInPage(page)).toBeVisible();
});

test('with sign-in off the Account page says so', async ({ page }) => {
  await open(page, '/settings/account');
  await expect(page.getByText('Sign-in is turned off')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});

test('MCP tokens are made, listed and revoked on the MCP server page', async ({ page }) => {
  await open(page, '/settings/mcp', SIGNED_IN);
  const section = page.getByRole('region', { name: 'MCP server' });
  await expect(section.getByText('make one under Tokens below', { exact: false })).toBeVisible();
  const tokens = section.getByRole('group', { name: 'Tokens' });
  await expect(tokens.getByText('No tokens yet.')).toBeVisible();

  await tokens.getByRole('button', { name: 'Create token' }).click();
  await expect(tokens.getByText('Give the token a name', { exact: false })).toBeVisible();

  await tokens.getByLabel('New token name').fill('Laptop – Claude Code');
  await tokens.getByRole('button', { name: 'Create token' }).click();
  const made = tokens.getByRole('status');
  await expect(made).toContainText('Token “Laptop – Claude Code” created');
  const token = await page.evaluate(() => (window as unknown as MockWindow).__codeatrophyMock.db.account.mcpTokens[0]!.token);
  await expect(made).toContainText(token);
  await expect(made).toContainText(`--header "Authorization: Bearer ${token}"`);

  const list = tokens.getByRole('list', { name: 'Tokens' });
  const row = list.getByRole('listitem').filter({ hasText: 'Laptop – Claude Code' });
  await expect(row).toContainText(`cat_…${token.slice(-4)}`);
  await expect(row).toContainText('made');
  await expect(row).toContainText('never used');

  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke token' }).click();
  await expect(tokens.getByText('No tokens yet.')).toBeVisible();
  await expect(made).toHaveCount(0);
});

test('without sign-in the MCP server page shows no tokens', async ({ page }) => {
  await open(page, '/settings/mcp', 'fast,mcp-token');
  const section = page.getByRole('region', { name: 'MCP server' });
  await expect(section.getByText('replace <your-token> with the value of CODEATROPHY_MCP_TOKEN', { exact: false })).toBeVisible();
  await expect(section.getByRole('group', { name: 'Tokens' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Create token' })).toHaveCount(0);
});
