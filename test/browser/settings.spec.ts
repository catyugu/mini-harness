import { expect } from '@playwright/test';
import { browserTest as test, expectInViewport, settingsSection } from '../support/browser.ts';

test('settings stay reachable across viewport sizes and theme changes persist', async ({ page, launch }) => {
  const { host } = await launch();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(host.url + '/#token=' + host.token);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const theme = dialog.getByRole('combobox', { name: 'Theme', exact: true });
  const contrast = () =>
    page.locator('.cm-placeholder').evaluate((node) => {
      const luminance = (color: string) => {
        const channels = color.match(/[0-9.]+/g)?.map((value) => Number(value) / 255) ?? [];
        return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
          const channel = channels[index];
          const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          return sum + weight * linear;
        }, 0);
      };
      const text = luminance(getComputedStyle(node).color);
      const surface = luminance(getComputedStyle(node.closest('.composer')!).backgroundColor);
      return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
    });
  for (const viewport of [
    { width: 1366, height: 900 },
    { width: 768, height: 1024 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 860) await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused();
    await expectInViewport(dialog, viewport);
    await settingsSection(page, 'General').click();
    await expect(dialog.getByRole('switch', { name: 'Add instructions' })).toBeVisible();
    if (viewport.width <= 560) {
      await dialog.getByRole('button', { name: 'All settings' }).click();
      await expect(settingsSection(page, 'General')).toBeFocused();
    }
    await settingsSection(page, 'Appearance').click();
    await theme.selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    expect(await contrast()).toBeGreaterThanOrEqual(4.5);
    await theme.selectOption('light');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
    expect(await contrast()).toBeGreaterThanOrEqual(4.5);
    await expect(theme).toBeEnabled();
    if (viewport.width > 860) {
      await dialog.getByRole('heading', { name: 'Appearance' }).click();
      await expect(dialog).toBeVisible();
      await page.mouse.click(4, 4);
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(dialog).toBeHidden();
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
