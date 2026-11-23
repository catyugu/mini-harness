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
    await page.waitForTimeout(1500); // Navigation and run event feeds keep network connections open.
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

test('a replacement token in a live tab reloads the app and restores authenticated requests', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const host = await startIsolatedHost(paths);
  try {
    await page.goto(host.url + '/#token=' + host.token);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    // A hash-only navigation to the same page used to leave ESM state and the old token intact.
    await page.evaluate(() => { location.hash = 'token=invalid-credential'; });
    await expect(page.locator('#startupStatus')).toContainText('Session authorization expired');
    await page.evaluate((token) => { location.hash = 'token=' + token; }, host.token);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expect(page.locator('#startupStatus')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('mini-harness-token'))).toBe(host.token);
  } finally {
    await host.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an already open tab reconnects to the same instance after restart', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  let host = await startIsolatedHost(paths);
  try {
    await page.goto(host.url + '/#token=' + host.token);
    const composer = page.getByRole('textbox', { name: 'Message' });
    await expect(composer).toBeVisible();
    await composer.fill('Before restart');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    const { url, token } = host;
    await host.stop();
    host = await startIsolatedHost(paths, Number(new URL(url).port));
    expect(host.token).toBe(token);
    await composer.fill('After restart');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    await expect(page.locator('#startupStatus')).toBeHidden();
  } finally {
    await page.close();
    await host.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('frontend API preserves caller headers and retains host authorization', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const host = await startIsolatedHost(paths);
  try {
    await page.goto(host.url + '/#token=' + host.token);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    const seen: Record<string, string>[] = [];
    await page.route('**/api/settings', async (route) => {
      seen.push(route.request().headers());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate(async () => {
      const { api } = await import(String('/packages/web/api.js')) as { api: (path: string, options: RequestInit) => Promise<Response> };
      await api('/settings', {
        method: 'PATCH',
        headers: new Headers({ 'X-Plugin-Request': 'present', 'Content-Type': 'application/merge-patch+json', Authorization: 'Bearer stale' }),
        body: '{}'
      });
    });
    expect(seen.at(-1)?.['x-plugin-request']).toBe('present');
    expect(seen.at(-1)?.['content-type']).toBe('application/merge-patch+json');
    expect(seen.at(-1)?.authorization).toBe('Bearer ' + host.token);
  } finally { await host.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
