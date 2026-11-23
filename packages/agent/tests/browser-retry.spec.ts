import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { readJson, writeJson } from '@mini-harness/platform/config';
import { startIsolatedHost, chooseModel } from '../../../test/support/browser.js';

test('retry retains image attachments after selecting an image-capable model', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const models = readJson<any>(join(paths.home, 'models.json'), {});
  models.providers['local-mock'].models.push({ ...models.providers['local-mock'].models[0], id: 'vision-model', input: ['text', 'image'] });
  writeJson(join(paths.home, 'models.json'), models);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.locator('#composer input[type=file]').setInputFiles(resolve('packages/web/icon-192.png'));
    await expect(page.locator('.attachment')).toHaveCount(1);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read the picture');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.error')).toContainText('does not support image input');
    await expect(page.locator('.attachment')).toHaveCount(1);
    await chooseModel(page, 'vision-model');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    expect(JSON.stringify(mock.requests.at(-1))).toContain('image_url');
    await expect(page.locator('.message.user').getByRole('img', { name: 'icon-192.png' })).toHaveCount(1);
    await expect(page.locator('.attachment')).toHaveCount(0);
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
