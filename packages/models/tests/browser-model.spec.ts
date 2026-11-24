import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { startIsolatedHost, modelButton, modelSearch, chooseModel } from '../../../test/support/browser.js';

test('the global recent model survives history navigation and page reload', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const models = readJson<any>(join(paths.home, 'models.json'), {});
  const first = models.providers['local-mock'].models[0];
  models.providers['local-mock'].models.push({ ...first, id: 'second-model', name: 'Second Model', reasoning: true });
  models.providers['unconfigured-fixture'] = { baseUrl: mock.url, api: 'openai-completions',
    models: [{ ...first, id: 'private-only', name: 'Private Only' }] };
  writeJson(join(paths.home, 'models.json'), models);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message' }).fill('Old model conversation');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await modelButton(page).click();
    await modelSearch(page).fill('private-only');
    await expect(page.getByText('No matching models.')).toBeVisible();
    await modelSearch(page).press('Escape');
    await chooseModel(page, 'local-mock second-model');
    await expect(modelButton(page)).toHaveText('Second Model');
    await page.reload();
    await expect(modelButton(page)).toHaveText('Mock Model');
    await chooseModel(page, 'second-model');
    await page.getByRole('button', { name: /New conversation/ }).click();
    const thinking = page.locator('#thinkingLevel');
    await expect(thinking).toHaveAttribute('aria-label', 'Thinking level: Default');
    await thinking.click();
    const levels = page.getByRole('listbox', { name: 'Thinking levels' });
    await expect(levels).toBeVisible();
    await levels.getByRole('option', { name: 'High', exact: true }).click();
    await expect(thinking).toHaveAttribute('aria-label', 'Thinking level: High');
    await page.getByRole('textbox', { name: 'Message' }).fill('New model conversation');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    expect(mock.requests.at(-1)?.model).toBe('second-model');
    await expect(thinking).toHaveAttribute('aria-label', 'Thinking level: High');
    await page.getByRole('button', { name: 'Old model conversation', exact: true }).click();
    await expect(modelButton(page)).toHaveText('Second Model');
    await page.reload();
    await expect(modelButton(page)).toHaveText('Second Model');
    await page.getByRole('textbox', { name: 'Message' }).fill('Use the recent model');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    expect(mock.requests.at(-1)?.model).toBe('second-model');
  } finally {
    await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true });
  }
});
