import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { startIsolatedHost } from '../support/browser.js';

test('composed browser plugin graph boots without any historical single app entry', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const host = await startIsolatedHost(paths);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    const bootstrap = await (await page.request.get(host.url + '/api/bootstrap', {
      headers: { Authorization: 'Bearer ' + host.token }
    })).json();
    assert.ok(Array.isArray(bootstrap.ui) && bootstrap.ui.length > 0, 'Host must publish UI graph');
    await page.goto(host.url + '/#token=' + host.token);
    await page.waitForLoadState('networkidle');
    const failure = await page.locator('#startupStatus').textContent();
    expect(await page.locator('#app').count(),
      'Browser startup failed: ' + failure + '; errors: ' + errors.join(' | ')).toBe(1);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    expect(errors, 'Unexpected browser errors').toEqual([]);
    expect((await page.request.get(host.url + '/packages/web-app/app.js')).status()).toBe(404);
  } finally {
    await host.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
