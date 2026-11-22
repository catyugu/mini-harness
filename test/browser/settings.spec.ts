import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { startIsolatedHost, settingsSection, chooseModel, expectInViewport } from './fixtures.js';

test('settings layout stays consistent across viewport sizes and themes', async ({ browser }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      try {
        await page.goto(service.url + '/#token=' + service.token);
        await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
        if (viewport.width <= 860) await page.getByRole('button', { name: 'Toggle navigation' }).click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings' });
        await expect(dialog).toBeVisible();
        await expect(settingsSection(page, 'Plugins')).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused();
        await settingsSection(page, 'Appearance').click();
        await dialog.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('system');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
        if (viewport.width <= 560) await dialog.getByRole('button', { name: 'All settings' }).click();
        await settingsSection(page, 'Model').click();
        await expect(dialog.getByRole('heading', { name: 'Model', exact: true })).toBeVisible();
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme });
          await expect(page.locator('html')).toHaveCSS('color-scheme', colorScheme);
          await expectInViewport(dialog, viewport);
        }
      } finally { await page.close(); }
    }
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('custom provider onboarding and registering a workspace work entirely in the GUI', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const second = join(root, 'another-workspace'); mkdirSync(second);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toHaveCount(0);
    await settings.getByRole('button', { name: 'Add provider' }).click();
    await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
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
    expect(mock.requests.at(-1).model).toBe('new-model');
    await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add workspace' });
    await expect(picker.getByLabel('Absolute directory path')).toHaveValue(paths.cwd);
    await picker.getByRole('button', { name: 'Up', exact: true }).click();
    await picker.getByRole('button', { name: 'another-workspace', exact: true }).click();
    await expect(picker.getByLabel('Absolute directory path')).toHaveValue(second);
    await picker.getByRole('button', { name: 'Add workspace', exact: true }).click();
    await expect(page.locator('#workspaceLabel')).toHaveText(second);
    await expect(page.locator('#sessions .session-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Configured from GUI', exact: true }).click();
    await expect(page.locator('#workspaceLabel')).toHaveText(paths.cwd);
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('switch transitions respect reduced motion and roll back a failed setting once', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    let requests = 0, release: () => void;
    const held = new Promise<void>((done) => { release = done; });
    await page.route('**/api/settings', async (route) => {
      requests++;
      await held;
      await route.fulfill({ status: 400, json: { error: 'The switch could not be saved' } });
    });
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Browse plugins' }).click();
    const files = page.getByRole('switch', { name: 'Workspace files', exact: true });
    const duration = () => files.evaluate((node) => getComputedStyle(node, '::after').transitionDuration);
    expect(await duration()).toBe('0.16s, 0.16s');
    await files.uncheck();
    await expect(files).toHaveAttribute('aria-busy', 'true');
    await expect(files).toBeDisabled();
    await files.evaluate((node: HTMLInputElement) => node.click());
    release();
    await expect(page.getByRole('status').filter({ hasText: 'The switch could not be saved' })).toBeVisible();
    await expect(files).toBeChecked();
    await expect(files).toBeEnabled();
    expect(requests).toBe(1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await duration()).toBe('0s, 0s');
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
