import { expect, test } from '@playwright/test';
import { cpSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { writeJson } from '../../packages/platform/config.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { startIsolatedHost } from '../support/browser.js';

test('a protocol 2 browser plugin owns and releases its page and dialog', async ({ page }) => {
  const mock = await createMockProvider();
  const { paths, root } = createFixturePaths(mock.url);
  let server: Awaited<ReturnType<typeof startIsolatedHost>>;
  try {
    cpSync(resolve('docs/examples/browser-panel'), join(paths.plugins, 'browser-panel'), { recursive: true });
    writeJson(paths.settings, { model: { provider: 'local-mock', id: 'mock-model' }, plugins: { 'browser-panel': true } });
    server = await startIsolatedHost(paths);
    await page.goto(server.url + '/#token=' + server.token);
    await page.getByRole('button', { name: 'Example panel', exact: true }).click();
    await expect(page.getByText('Example panel is ready.')).toBeVisible();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Example preview' })).toBeVisible();
    const settings = await fetch(server.url + '/api/settings', {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: { 'browser-panel': false } })
    });
    expect(settings.status).toBe(200);
    await expect(page.getByRole('dialog', { name: 'Example preview' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Example panel', exact: true })).toHaveCount(0);
    await expect(page.getByText('Example panel is ready.')).toHaveCount(0);
  } finally {
    await server?.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
