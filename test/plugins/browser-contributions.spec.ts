import { expect, test } from '@playwright/test';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { writeJson } from '../../packages/platform/config.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { startIsolatedHost } from '../support/browser.js';

test('a browser plugin owns and releases its page and dialog', async ({ page }) => {
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

test('a keyed browser contribution cleans up its listener and restores the built-in control', async ({ page }) => {
  const mock = await createMockProvider();
  const { paths, root } = createFixturePaths(mock.url);
  let server: Awaited<ReturnType<typeof startIsolatedHost>>;
  try {
    const folder = join(paths.plugins, 'replace-new');
    mkdirSync(folder);
    writeJson(join(folder, 'plugin.json'), { browserRequires: ['core:conversation'] });
    writeFileSync(join(folder, 'web.js'), `export default (_ctx, api) => {
      api.slots.registerKeyed('sidebar.primary', 'new-conversation', signal => {
        const button = api.ui.button('Replacement conversation', 'quiet');
        window.addEventListener('slot-test', () => {
          document.body.dataset.slotEvents = String(Number(document.body.dataset.slotEvents ?? 0) + 1);
        }, { signal });
        return { node: button, dispose() { document.body.dataset.slotDisposed = 'yes'; } };
      });
      api.slots.decorate('sidebar.primary', 'new-conversation', (button) => {
        const wrapper = document.createElement('section');
        wrapper.dataset.testid = 'new-conversation-wrapper';
        wrapper.append(button);
        return wrapper;
      });
    };`);
    writeJson(paths.settings, { model: { provider: 'local-mock', id: 'mock-model' }, plugins: { 'replace-new': true } });
    server = await startIsolatedHost(paths);
    await page.goto(server.url + '/#token=' + server.token);
    await expect(page.getByTestId('new-conversation-wrapper').getByRole('button', { name: 'Replacement conversation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('slot-test')));
    await expect(page.locator('body')).toHaveAttribute('data-slot-events', '1');

    const settings = await fetch(server.url + '/api/settings', {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: { 'replace-new': false } })
    });
    expect(settings.status).toBe(200);
    await expect(page.getByTestId('new-conversation-wrapper')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-slot-disposed', 'yes');
    await page.evaluate(() => window.dispatchEvent(new Event('slot-test')));
    await expect(page.locator('body')).toHaveAttribute('data-slot-events', '1');
  } finally {
    await server?.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
