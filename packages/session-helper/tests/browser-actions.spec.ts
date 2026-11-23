import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { startIsolatedHost } from '../../../test/support/browser.js';

test('message actions use icons and allow copying or editing the text', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    const prompt = page.getByRole('textbox', { name: 'Message', exact: true });
    await prompt.fill('Edit me');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message-row.assistant .message')).toHaveText('Mock response');
    await expect(page.locator('.message-row.user .message-action')).toHaveCount(2);
    await expect(page.locator('.message-row.assistant .message-action')).toHaveCount(1);
    await expect(page.locator('.message-time')).toHaveCount(2);

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: {
          writeText: async (text: string) => { (window as Window & { copiedMessage?: string }).copiedMessage = text; }
        }
      });
    });
    await page.locator('.message-row.assistant').getByRole('button', { name: 'Copy message' }).click();
    await expect(page.locator('.message-row.assistant').getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { copiedMessage?: string }).copiedMessage)).toBe('Mock response');

    await page.locator('.message-row.user').getByRole('button', { name: 'Edit message' }).click();
    await expect(prompt).toHaveValue('Edit me');
    await expect(prompt).toBeFocused();
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
