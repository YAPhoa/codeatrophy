import type { Page } from '@playwright/test';

/** Open the app with short mock delays, and fail the test on any page error or third-party request. */
export async function open(page: Page, path: string): Promise<void> {
  page.on('pageerror', (error) => {
    throw error;
  });
  page.on('request', (request) => {
    const { hostname } = new URL(request.url());
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') throw new Error(`request to a third-party origin: ${request.url()}`);
  });
  const [route = '', hash] = path.split('#');
  await page.goto(`${route}${route.includes('?') ? '&' : '?'}mock=fast${hash ? `#${hash}` : ''}`);
}
