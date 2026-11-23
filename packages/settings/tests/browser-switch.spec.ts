import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../../../../test/helpers/mock-provider.js';
import { startIsolatedHost, settingsSection, chooseModel, expectInViewport } from '../../../../test/support/browser.js';

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
