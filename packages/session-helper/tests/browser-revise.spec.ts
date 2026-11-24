import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/config';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { startIsolatedHost } from '../../../test/support/browser.js';

test('editing a user message creates a native branch from the editor on mobile and desktop', async ({ browser }) => {
  const mock = await createMockProvider(({ messages }) => 'Response: ' + messages.filter((entry) => entry.role === 'user').at(-1)?.content);
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const { root, paths } = createFixturePaths(mock.url);
      const modelFile = join(paths.home, 'models.json');
      const models = readJson<any>(modelFile, {});
      models.providers['local-mock'].models[0].input.push('image');
      writeJson(modelFile, models);
      const service = await startIsolatedHost(paths);
      const page = await browser.newPage({ viewport });
      try {
        await page.goto(service.url + '/#token=' + service.token);
        const prompt = page.getByRole('textbox', { name: 'Message' });
        await prompt.fill('Original prompt');
        await page.locator('#composer input[type=file]').setInputFiles(resolve('packages/ui-runtime/assets/icon-192.png'));
        await expect(page.getByRole('button', { name: 'Remove icon-192.png' })).toBeVisible();
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.locator('.message-row.assistant .message')).toHaveText('Response: Original prompt');
        await page.locator('.message-row.user').getByRole('button', { name: 'Edit message' }).click();
        await expect(page.locator('#draftMode')).toBeVisible();
        await expect(prompt).toHaveValue('Original prompt');
        await expect(page.getByRole('button', { name: 'Remove icon-192.png' })).toBeVisible();
        await prompt.fill('Revised prompt');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.locator('.message-row.assistant .message')).toHaveText('Response: Revised prompt');
        await expect(page.locator('.message-row.user .message')).toContainText('Revised prompt');
        await expect(page.locator('.message.user').getByRole('img', { name: 'icon-192.png' })).toHaveCount(1);
        expect(JSON.stringify(mock.requests.at(-1))).toContain('image_url');
        await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
        await page.locator('.message-row.user').getByRole('button', { name: 'Edit message' }).click();
        await page.getByRole('button', { name: 'Remove icon-192.png' }).click();
        await prompt.fill('Removed picture');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.locator('.message-row.assistant .message')).toHaveText('Response: Removed picture');
        await expect(page.locator('.message.user').getByRole('img', { name: 'icon-192.png' })).toHaveCount(0);
        expect(JSON.stringify(mock.requests.at(-1))).not.toContain('image_url');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        await page.close(); await service.stop(); rmSync(root, { recursive: true, force: true });
      }
    }
  } finally { await mock.close(); }
});
