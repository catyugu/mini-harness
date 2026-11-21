import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { createMiniHarnessServer } from '../../src/server.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

test('desktop and mobile: send, navigate, settings and bulk select', async ({ browser }) => {
  const mock = await createMockProvider();
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      const { root, paths } = createFixturePaths(mock.url);
      const app = await createMiniHarnessServer(paths);
      const page = await browser.newPage({ viewport });
      const browserErrors: string[] = [];
      page.on('console', (msg) => { if (msg.type() === 'error') browserErrors.push(msg.text()); });
      page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
      page.on('requestfailed', (req) => browserErrors.push('Request failed: ' + req.url() + ': ' + req.failure()?.errorText));
      try {
        const port = await app.listen(0);
        await page.goto('http://127.0.0.1:' + port + '/#token=' + app.token);
        await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
        await page.getByRole('textbox', { name: 'Message' }).fill('Hello from the browser');
        await page.getByRole('button', { name: 'Send' }).click();
        try {
          await expect(page.locator('.message.assistant')).toHaveText('Mock response', { timeout: 12000 });
        } catch (error) {
          console.error('BROWSER-DIAGNOSTIC', JSON.stringify({
            mockRequests: mock.requests,
            status: await page.locator('#status').textContent(),
            messages: await page.locator('#messages').allTextContents(),
            model: await page.locator('#modelSelect').inputValue(),
            sessionTitle: await page.locator('#conversationTitle').textContent(),
            browserErrors
          }));
          throw error;
        }

        if (viewport.width < 1000) await page.getByRole('button', { name: 'Toggle navigation' }).click();
        await page.getByRole('button', { name: 'Select', exact: true }).click();
        await page.getByRole('checkbox', { name: /Select Hello from the browser/ }).first().check();
        await expect(page.getByText('1 selected')).toBeVisible();
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('button', { name: 'Settings' }).click();
        await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
        await expect(page.getByRole('checkbox', { name: /Shell/ })).not.toBeChecked();
        await page.getByRole('button', { name: 'Close settings' }).click();
      } finally {
        await page.close();
        await app.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    await mock.close();
  }
});
