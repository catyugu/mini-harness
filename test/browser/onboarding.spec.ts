import { expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserTest as test, chooseModel } from '../support/browser.ts';

test('create and edit a provider, reconcile its discovered catalog, and use the saved model', async ({
  page,
  launch,
}) => {
  const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  const { host, mock, paths } = await launch({
    prepare(paths) {
      const file = join(paths.home, 'models.json');
      const config = JSON.parse(readFileSync(file, 'utf8'));
      Object.assign(config.providers['local-mock'].models[0], {
        compat: { requiresToolResultName: true },
        thinkingLevelMap: { high: 'high' },
        cost,
      });
      writeFileSync(file, JSON.stringify(config));
    },
  });
  await page.setViewportSize({ width: 420, height: 780 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(host.url + '/#token=' + host.token);
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Model', exact: true }).click();
  await settings.getByRole('button', { name: 'Add provider' }).click();
  await settings.getByText('Custom API', { exact: true }).click();
  const form = settings.getByRole('form', { name: 'Add provider' });
  await form.getByLabel('Provider ID').fill('gui-added');
  await form.getByLabel('Display name', { exact: true }).fill('GUI Provider');
  await form.getByLabel('API endpoint').fill(mock.url);
  await form.getByLabel('API key').fill('test-only-key');
  await form.getByRole('button', { name: 'Add model', exact: true }).click();
  await form.getByLabel('Model ID').fill('manual-only');
  await form.getByRole('button', { name: 'Fetch available models' }).click();
  const discovery = page.getByRole('dialog', { name: 'Select models' });
  await discovery.getByRole('checkbox', { name: 'Select all' }).check();
  await discovery.getByRole('button', { name: 'Apply selection' }).click();
  await form.getByRole('button', { name: 'Create provider', exact: true }).click();
  await settings.getByRole('button', { name: 'Edit GUI Provider', exact: true }).click();
  const editor = settings.getByRole('form', { name: 'Edit GUI Provider' });
  const rows = editor.getByRole('group', { name: 'Model', exact: true });
  await expect(rows).toHaveCount(3);
  const discovered = rows.last();
  await discovered.getByRole('button', { name: 'Advanced model settings' }).click();
  await expect(discovered.getByRole('spinbutton', { name: 'Context window' })).toHaveValue('65536');
  await discovered.getByLabel('Display name').fill('GUI Model edited');
  await editor.getByRole('button', { name: 'Fetch available models' }).click();
  await discovery.getByRole('checkbox', { name: 'mock-model', exact: true }).uncheck();
  await discovery.getByRole('button', { name: 'Apply selection' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByLabel('Model ID')).toHaveValue('manual-only');
  await expect(rows.last().getByLabel('Display name')).toHaveValue('GUI Model edited');
  await rows.last().getByRole('button', { name: 'Advanced model settings' }).click();
  await rows.last().getByLabel('Drag to reorder').dragTo(rows.first(), {
    targetPosition: { x: 20, y: 8 },
  });
  await expect(rows.last().getByLabel('Model ID')).toHaveValue('manual-only');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await settings.getByRole('button', { name: 'Edit GUI Provider', exact: true }).click();
  await expect(
    editor.getByRole('group', { name: 'Model', exact: true }).last().getByLabel('Model ID'),
  ).toHaveValue('manual-only');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await settings.getByRole('button', { name: 'Edit local-mock', exact: true }).click();
  const native = settings.getByRole('form', { name: 'Edit local-mock' });
  await native.getByLabel('API protocol').selectOption('google-generative-ai');
  await native.getByRole('button', { name: 'Save changes' }).click();
  await page
    .getByRole('dialog', { name: 'Change API protocol' })
    .getByRole('button', { name: 'Save changes' })
    .click();
  await expect(settings.getByText('Provider saved.', { exact: true })).toBeVisible();
  const saved = JSON.parse(readFileSync(join(paths.home, 'models.json'), 'utf8')).providers['local-mock'];
  expect(saved.api).toBe('google-generative-ai');
  expect(saved.models[0].cost).toEqual(cost);
  expect(saved.models[0]).not.toHaveProperty('compat');
  expect(saved.models[0]).not.toHaveProperty('thinkingLevelMap');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.setViewportSize({ width: 1440, height: 820 });
  await chooseModel(page, 'GUI Model edited');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Configured from GUI');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  expect(mock.requests.at(-1)?.model).toBe('discovered-model');
});
