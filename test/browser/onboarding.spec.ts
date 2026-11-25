import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.ts';
import { startIsolatedHost, chooseModel } from '../support/browser.ts';

// Resolve Windows 8.3 aliases (e.g. RUNNER~1) and symlinks before comparing paths.
// Only Windows path comparisons are case-insensitive.
function canonicalPath(path: string) {
  const resolved = realpathSync.native(path.trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

test('custom provider onboarding and registering a workspace work entirely in the GUI', async ({ page }) => {
  const mock = await createMockProvider(),
    { root, paths } = createFixturePaths(mock.url);
  const second = join(root, 'another-workspace');
  mkdirSync(second);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Model', exact: true }).click();
    await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toHaveCount(0);
    await settings.getByRole('button', { name: 'Add provider' }).click();
    await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.locator('.provider-editor [role="alert"]')).not.toBeEmpty();
    await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toBeFocused();
    await settings.getByRole('radio', { name: 'Custom API' }).check();
    await settings.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('gui-added');
    await settings.getByRole('textbox', { name: 'API endpoint', exact: true }).fill(mock.url);
    await settings.getByRole('textbox', { name: 'Model ID', exact: true }).fill('new-model');
    await settings.getByRole('textbox', { name: 'Display name', exact: true }).fill('GUI Model');
    await settings.getByLabel('API key', { exact: true }).fill('test-only-key');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Provider saved.', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Edit gui-added', exact: true }).click();
    await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('');
    await settings.getByRole('textbox', { name: 'Display name', exact: true }).fill('GUI Model edited');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Provider saved.', { exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Edit gui-added', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await chooseModel(page, 'GUI Model edited');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Configured from GUI');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    expect(mock.requests.at(-1)?.model).toBe('new-model');
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
    await expect
      .poll(async () => canonicalPath(await workspaceButton.innerText()))
      .toBe(canonicalPath(second));
    await expect(page.locator('#sessions .session-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Configured from GUI', exact: true }).click();
    await expect
      .poll(async () => canonicalPath(await workspaceButton.innerText()))
      .toBe(canonicalPath(paths.cwd));
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
