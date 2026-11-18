import { defineConfig, devices } from '@playwright/test';

// The smoke suite drives the real UI in a browser against the in-memory API
// mock (`npm run dev:mock`), so it needs no backend, AI provider or judge.
const PORT = Number(process.env.E2E_PORT ?? 5174);
// The tests in e2e/built judge how a reload paints, which depends on the
// production build: they run against one made with the mock and served by
// `vite preview`, kept out of the working tree like the other artefacts.
const BUILT_PORT = Number(process.env.E2E_BUILT_PORT ?? 5175);
const BUILT_DIR = 'node_modules/.tmp/e2e-built';
const browser = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };

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
  projects: [
    { name: 'chromium', testIgnore: /built\//, use: browser },
    { name: 'built', testMatch: /built\/.*\.spec\.ts/, use: { ...browser, baseURL: `http://localhost:${BUILT_PORT}` } },
  ],
  webServer: [
    {
      command: `npm run dev:mock -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Always built afresh: a server left running would serve an old build.
      command: `npx vite build --mode mock --outDir ${BUILT_DIR} --emptyOutDir --logLevel warn && npx vite preview --mode mock --outDir ${BUILT_DIR} --port ${BUILT_PORT} --strictPort`,
      url: `http://localhost:${BUILT_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
