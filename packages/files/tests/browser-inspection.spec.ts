import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { startIsolatedHost, settingsSection, expectInViewport } from '../../../test/support/browser.js';

test('file inspection, responsive themes and reduced viewport height keep controls reachable', async ({ browser }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const note = join(paths.cwd, 'notes.md');
  writeFileSync(note, '# Visible file\nBefore edits');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: paths.cwd });
  git('init', '--quiet');
  git('add', 'notes.md');
  writeFileSync(note, '# Visible file\nWorkspace content');
  const service = await startIsolatedHost(paths);
  try {
    for (const width of [1366, 768, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      try {
        await page.goto(service.url + '/#token=' + service.token);
        if (width <= 860) {
          const navigation = page.getByRole('button', { name: 'Toggle navigation' });
          const close = page.getByRole('dialog', { name: 'Conversations' }).getByRole('button', { name: 'Close navigation' });
          await navigation.click();
          await expect(close).toBeFocused();
          await close.press('Shift+Tab');
          await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(navigation).toBeFocused();
          await navigation.click();
        }
        if (width <= 860) await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Open workspace panel', exact: true }).click();
        const panel = page.locator('#inspector');
        await expect(panel.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Browse files', exact: true })).toHaveCount(0);
        await expect(panel.getByRole('button', { name: 'Git changes', exact: true })).toHaveCount(0);
        const file = panel.getByRole('button', { name: 'notes.md AM', exact: true });
        await expect(file).toBeVisible();
        expect(await file.evaluate((node) => getComputedStyle(node).justifyContent)).toBe('flex-start');
        expect(await file.evaluate((node) => node.querySelector('svg').getBoundingClientRect().left -
          node.getBoundingClientRect().left)).toBeLessThan(32);
        await file.click();
        await panel.getByRole('button', { name: 'Diff', exact: true }).click();
        await expect(panel.locator('.diff .added')).toHaveText(['+# Visible file', '+Before edits', '+Workspace content']);
        await panel.getByRole('button', { name: 'Preview', exact: true }).click();
        await expect(panel.getByRole('tab', { name: 'notes.md', exact: true })).toBeFocused();
        await expect(panel.getByRole('heading', { name: 'Visible file' })).toBeVisible();
        await panel.getByRole('button', { name: 'Source', exact: true }).click();
        await expect(panel.locator('.file-preview')).toHaveText('# Visible file\nWorkspace content');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expectInViewport(panel, { width, height: 700 });
        await panel.getByRole('button', { name: 'Close workspace panel' }).click();
        for (const theme of ['dark', 'light']) {
          if (width <= 860) await page.getByRole('button', { name: 'Toggle navigation' }).click();
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
          await settingsSection(page, 'Appearance').click();
          await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await page.getByRole('button', { name: 'Close settings' }).click();
        }
        await page.setViewportSize({ width, height: 380 });
        await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A long task '.repeat(100));
        const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
        expect(send.y + send.height).toBeLessThanOrEqual(380);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally { await page.close(); }
    }
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
