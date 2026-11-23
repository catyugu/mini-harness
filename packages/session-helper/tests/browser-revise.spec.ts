import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { readJson, writeJson } from '../../platform/config.js';
import { startIsolatedHost, settingsSection, modelButton, modelSearch, suggestions, chooseModel } from '../../../test/support/browser.js';

test('editing a user message creates a new Pi branch from the editor on mobile and desktop', async ({ browser }) => {
  const mock = await createMockProvider(({ messages }) => 'Response: ' + messages.filter((entry) => entry.role === 'user').at(-1)?.content);
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const { root, paths } = createFixturePaths(mock.url);
      const service = await startIsolatedHost(paths);
      const page = await browser.newPage({ viewport });
      try {
        await page.goto(service.url + '/#token=' + service.token);
        const prompt = page.getByRole('textbox', { name: 'Message' });
        await prompt.fill('Original prompt');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.locator('.message-row.assistant .message')).toHaveText('Response: Original prompt');
        await page.locator('.message-row.user').getByRole('button', { name: 'Edit message' }).click();
        await expect(page.locator('#draftMode')).toBeVisible();
        await expect(prompt).toHaveValue('Original prompt');
        await prompt.fill('Revised prompt');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.locator('.message-row.assistant .message')).toHaveText('Response: Revised prompt');
        await expect(page.locator('.message-row.user .message')).toHaveText('Revised prompt');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        await page.close(); await service.stop(); rmSync(root, { recursive: true, force: true });
      }
    }
  } finally { await mock.close(); }
});
