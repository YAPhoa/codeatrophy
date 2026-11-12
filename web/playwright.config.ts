import { defineConfig, devices } from '@playwright/test';

// The smoke suite drives the real UI in a browser against the in-memory API
// mock (`npm run dev:mock`), so it needs no backend, AI provider or judge.
const PORT = Number(process.env.E2E_PORT ?? 5174);

export default defineConfig({
  testDir: 'e2e',
  // Keep artefacts out of the working tree.
  outputDir: 'node_modules/.tmp/e2e-results',
  reporter: 'list',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npm run dev:mock -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
