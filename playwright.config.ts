import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the librarian portal (tests/e2e). They run against `astro dev`; the
 * librarian API and Netlify Identity are stood in for inside each test (see
 * tests/e2e/support/portal.ts), so no database, Identity instance or Netlify CLI is needed.
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 */
const PORT = 4321;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx astro dev --port ${PORT}`,
    url: `http://localhost:${PORT}/web/librarian/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
