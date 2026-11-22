import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/dist/**', '**/node_modules/**'],
  timeout: 90000,
  use: { browserName: 'chromium', headless: true, actionTimeout: 12000, screenshot: 'only-on-failure', trace: 'retain-on-failure', launchOptions: {
    executablePath: process.env.MINI_HARNESS_CHROMIUM
  } },
  reporter: 'list',
  workers: 1
});
