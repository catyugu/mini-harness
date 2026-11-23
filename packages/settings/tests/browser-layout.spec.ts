import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { startIsolatedHost, settingsSection, expectInViewport } from '../../../test/support/browser.js';

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
