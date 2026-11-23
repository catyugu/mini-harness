import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { startIsolatedHost } from '../../../test/support/browser.js';

test('session-helper has one plugin switch controlling both message actions', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Copy and edit together');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message-row.assistant .message')).toHaveText('Mock response');
    const userActions = page.locator('.message-row.user .message-action');
    await expect(userActions).toHaveCount(2);
    await page.getByRole('button', { name: 'Browse plugins' }).click();
    await expect(page.locator('[data-plugin-row="session-helper"]')).toHaveCount(1);
    await expect(page.locator('[data-plugin-row="message-copy"], [data-plugin-row="edit-resend"]')).toHaveCount(0);

    const switcher = page.locator('[data-plugin-toggle="session-helper"]');
    await switcher.uncheck();
    await expect(userActions).toHaveCount(0);
    await expect(page.locator('.message-row.assistant .message-action')).toHaveCount(0);
    await switcher.check();
    await expect(userActions).toHaveCount(2);
    await expect(page.locator('.message-row.assistant .message-action')).toHaveCount(1);
  } finally {
    await page.close(); await service.stop(); await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
