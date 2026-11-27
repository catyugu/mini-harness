import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../support/mock-provider.ts';
import { browserTest as test, startIsolatedHost } from '../support/browser.ts';

test('workspace source, preview and diff remain available as the panel changes mode', async ({
  page,
  launch,
}) => {
  const { host } = await launch({
    prepare({ cwd }) {
      const note = join(cwd, 'notes.md');
      writeFileSync(note, '# Notes\nBefore edits');
      execFileSync('git', ['init', '--quiet'], { cwd });
      execFileSync('git', ['add', 'notes.md'], { cwd });
      writeFileSync(note, '# Notes\nReadable code');
    },
  });
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto(host.url + '/#token=' + host.token);
  await page.getByRole('button', { name: 'Open workspace panel' }).click();
  const panel = page.getByRole('complementary', { name: 'Workspace panel' });
  await panel.getByRole('button', { name: /Workspace files/ }).click();
  await panel.getByRole('button', { name: 'notes.md', exact: true }).click();
  await panel.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(panel.locator('.file-preview')).toContainText('Readable code');
  await panel.getByRole('button', { name: 'Source', exact: true }).click();
  await panel.getByRole('button', { name: 'Workspace panel home' }).click();
  await panel.getByRole('button', { name: /Git changes/ }).click();
  await panel.getByRole('button', { name: /^notes.md/ }).click();
  await expect(panel.locator('.diff')).toContainText('+Readable code');
  await panel.getByRole('tab', { name: 'notes.md', exact: true }).click();

  const resize = panel.getByRole('separator');
  await resize.press('ArrowLeft');
  await expect(resize).toHaveAttribute('aria-valuenow', '400');
  await page.setViewportSize({ width: 1190, height: 760 });
  await expect(resize).toHaveAttribute('aria-valuenow', '330');
  await page.setViewportSize({ width: 900, height: 670 });
  const drawer = page.getByRole('dialog', { name: 'Workspace panel' });
  await expect(drawer.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 760 });
  await expect(resize).toHaveAttribute('aria-valuenow', '400');
  await expect(panel.getByRole('heading', { name: 'Notes' })).toBeVisible();
});

test('an open file preview and diff refresh after an agent write', async ({ page }) => {
  const mock = await createMockProvider(({ messages }) =>
    messages.at(-1)?.role === 'tool'
      ? 'Done'
      : { tool: 'write', args: { path: 'update.js', content: 'const updated = 2;\n' } },
  );
  const { root, paths } = createFixturePaths(mock.url);
  const file = join(paths.cwd, 'update.js');
  writeFileSync(file, 'const updated = 1;\n');
  execFileSync('git', ['init', '--quiet'], { cwd: paths.cwd });
  execFileSync('git', ['add', 'update.js'], { cwd: paths.cwd });
  const service = await startIsolatedHost(paths);
  let finishSettings = () => {};
  const settingsReady = new Promise<void>((resolve) => {
    finishSettings = resolve;
  });
  await page.route('**/api/settings', async (route) => {
    await settingsReady;
    await route.continue();
  });
  try {
    await page.goto(service.url + '/#token=' + service.token);
    try {
      await page.getByRole('button', { name: 'Open workspace panel', exact: true }).click();
    } finally {
      finishSettings();
    }
    const panel = page.getByRole('complementary', { name: 'Workspace panel' });
    await panel.getByRole('button', { name: /Git changes/ }).click();
    await panel.getByRole('button', { name: /^update.js/ }).click();
    await expect(panel.locator('.diff:visible')).toContainText('const updated = 1;');
    await panel.getByRole('button', { name: 'Workspace panel home' }).click();
    await panel.getByRole('button', { name: /Workspace files/ }).click();
    await panel.getByRole('button', { name: 'update.js', exact: true }).click();
    await expect(panel.locator('.file-preview')).toContainText('const updated = 1;');
    await expect(panel.locator('.file-preview')).toHaveAttribute('aria-hidden', 'true');
    await expect(panel.locator('.file-accessible-source')).toHaveText('const updated = 1;');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Update the file @"update.js"');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(panel.locator('.file-preview')).toContainText('const updated = 2;');
    await panel.getByRole('tab', { name: 'Diff: update.js', exact: true }).click();
    await expect(panel.locator('.diff .added')).toContainText(['+const updated = 1;', '+const updated = 2;']);
    const preview = panel.getByRole('tab', { name: 'update.js', exact: true });
    await preview.click();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    writeFileSync(file, 'const updated = 3;\n');
    await page.locator('.message.user').getByRole('button', { name: 'update.js', exact: true }).click();
    await expect(preview).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('.file-preview:visible')).toContainText('const updated = 3;');
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
