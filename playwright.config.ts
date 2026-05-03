import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e/results/playwright-results.json' }],
  ],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'api',
      // API-only project — no browser required; uses request fixture (Playwright APIRequestContext).
      use: {},
    },
  ],
});
