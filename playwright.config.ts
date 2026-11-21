import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  timeout: 90000,
  use: { browserName: 'chromium', headless: true, launchOptions: {
    executablePath: process.env.MINI_HARNESS_CHROMIUM
  } },
  reporter: 'list',
  workers: 1
});
