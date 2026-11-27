import { expect } from '@playwright/test';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { browserTest as test, chooseModel } from '../support/browser.ts';

// Resolve Windows 8.3 aliases (e.g. RUNNER~1) and symlinks before comparing paths.
// Only Windows path comparisons are case-insensitive.
function canonicalPath(path: string) {
  const resolved = realpathSync.native(path.trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

test('custom provider onboarding and registering a workspace work entirely in the GUI', async ({
  page,
  launch,
}) => {
  const { host, mock, paths, root } = await launch({
    prepare(_, root) {
      mkdirSync(join(root, 'another-workspace'));
    },
  });
  const second = join(root, 'another-workspace');
  await page.setViewportSize({ width: 420, height: 780 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(host.url + '/#token=' + host.token);
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Model', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Add provider' }).click();
  await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
  const create = settings.getByRole('button', { name: 'Create provider', exact: true });
  await create.click();
  await expect(settings.getByRole('alert')).not.toBeEmpty();
  await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toBeFocused();
  await settings.getByText('Custom API', { exact: true }).click();
  const form = settings.getByRole('form', { name: 'Add provider' });
  await form.getByLabel('Provider ID').fill('gui-added');
  await form.getByLabel('Display name', { exact: true }).fill('GUI Provider');
  await expect(form.getByText('No models in this catalog.')).toBeVisible();
  const endpoint = form.getByLabel('API endpoint');
  await endpoint.fill(mock.url + '/missing');
  await form.getByLabel('API key').fill('test-only-key');
  const fetch = form.getByRole('button', { name: 'Fetch available models' });
  await fetch.click();
  await expect(form.getByRole('alert')).toContainText('HTTP 404');
  await endpoint.fill(mock.url);
  await form.getByRole('button', { name: 'Add model', exact: true }).click();
  await form.getByLabel('Model ID').fill('mock-model');
  await form.getByLabel('Display name', { exact: true }).last().fill('Manual Model');
  await fetch.click();
  const discovery = page.getByRole('dialog', { name: 'Select models' });
  await expect(discovery.getByRole('checkbox', { name: 'mock-model', exact: true })).toBeChecked();
  await discovery.getByRole('checkbox', { name: 'mock-model', exact: true }).uncheck();
  await discovery.getByRole('searchbox', { name: 'Search models' }).fill('Discovered Model');
  await discovery.getByRole('checkbox', { name: 'Select all' }).check();
  await discovery.getByRole('button', { name: 'Add selected' }).click();
  await expect(form.getByText('Manual Model', { exact: true })).toBeVisible();
  await create.click();
  await expect(settings.getByText('Provider saved.', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Edit GUI Provider', exact: true }).click();
  const editor = settings.getByRole('form', { name: 'Edit GUI Provider' });
  await expect(editor.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('Provider ID')).toHaveAttribute('readonly', '');
  await editor.getByText('discovered-model', { exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: 'Context window' })).toHaveValue('65536');
  await editor.getByLabel('Display name', { exact: true }).last().fill('GUI Model edited');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(settings.getByText('Provider saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.setViewportSize({ width: 1440, height: 820 });
  await chooseModel(page, 'GUI Model edited');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Configured from GUI');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  expect(mock.requests.at(-1)?.model).toBe('discovered-model');
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Add workspace' });
  const absolutePath = picker.getByLabel('Absolute directory path');
  await expect
    .poll(async () => canonicalPath(await absolutePath.inputValue()))
    .toBe(canonicalPath(paths.cwd));
  await picker.getByRole('button', { name: 'Up', exact: true }).click();
  await picker.getByRole('button', { name: 'another-workspace', exact: true }).click();
  await expect.poll(async () => canonicalPath(await absolutePath.inputValue())).toBe(canonicalPath(second));
  await picker.getByRole('button', { name: 'Add workspace', exact: true }).click();
  const workspaceButton = page.locator('.workspace-button:visible');
  await expect.poll(async () => canonicalPath(await workspaceButton.innerText())).toBe(canonicalPath(second));
  await expect(page.locator('#sessions .session-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Configured from GUI', exact: true }).click();
  await expect
    .poll(async () => canonicalPath(await workspaceButton.innerText()))
    .toBe(canonicalPath(paths.cwd));
  await expect(page.locator('.message.assistant')).toHaveText('Mock response');
});
