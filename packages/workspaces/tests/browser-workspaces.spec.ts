import { expectPresent } from '../../../test/support/required.js';
import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { startIsolatedHost } from '../../../test/support/browser.js';

test('switching workspaces preserves running conversations and each workspace’s file tabs', async ({ page }) => {
  let entered: () => void = () => { throw new Error('Not started'); };
  let release: () => void = () => { throw new Error('Not started'); };
  const waiting = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  const mock = await createMockProvider(async ({ messages }) => {
    if (messages.at(-1)?.content === 'Keep working here') { entered(); await held; return 'First workspace finished'; }
    return 'Second workspace finished';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const second = join(paths.cwd, 'nested');
  mkdirSync(second);
  for (const [directory, text] of [[paths.cwd, 'first'], [second, 'second']]) {
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src', 'common.ts'), 'const workspace = "' + text + '";');
  }
  const service = await startIsolatedHost(paths);
  try {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(service.url + '/#token=' + service.token);
    const nav = page.getByRole('navigation', { name: 'Conversation tree' });
    const prompt = page.getByRole('textbox', { name: 'Message', exact: true });
    const panel = page.getByRole('complementary', { name: 'Workspace panel' });
    const open = page.getByRole('button', { name: 'Open workspace panel', exact: true });
    const close = () => panel.getByRole('button', { name: 'Close workspace panel' }).click();
    await prompt.fill('Keep working here');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waiting;
    await expect(nav.getByRole('button', { name: 'Keep working here', exact: true })).toBeVisible();
    await open.click();
    await panel.locator('summary').filter({ hasText: /^src$/ }).click();
    await panel.getByRole('button', { name: 'common.ts', exact: true }).click();
    await expect(panel.locator('.syntax-string')).toHaveText('"first"');
    await expect(panel.locator('.source-line')).toHaveAttribute('data-line', '1');
    const separator = panel.getByRole('separator');
    await expect(separator).toHaveAttribute('aria-valuenow', '380');
    await separator.press('ArrowLeft');
    await expect(separator).toHaveAttribute('aria-valuenow', '400');
    await expect.poll(() => panel.evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(400);
    const handle = expectPresent(await separator.boundingBox(), 'panel resize handle');
    await page.mouse.move(handle.x + 3, handle.y + 60);
    await page.mouse.down();
    await page.mouse.move(handle.x - 37, handle.y + 60);
    await expect(separator).toHaveAttribute('aria-valuenow', '440');
    await expect(panel).toHaveCSS('transition-property', 'none');
    await page.mouse.up();
    await close();
    await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add workspace' });
    await picker.getByLabel('Absolute directory path').fill(second);
    await picker.getByRole('button', { name: 'Add workspace', exact: true }).click();
    await nav.getByRole('button', { name: 'New in nested', exact: true }).click();
    await prompt.fill('Start in the child workspace');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Second workspace finished');
    await open.click();
    await panel.locator('summary').filter({ hasText: /^src$/ }).click();
    await panel.getByRole('button', { name: 'common.ts', exact: true }).click();
    await expect(panel.locator('.syntax-string')).toHaveText('"second"');
    await close();
    await nav.getByRole('button', { name: 'Keep working here', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    await open.click();
    await expect(panel.getByRole('tab', { name: 'common.ts', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('.syntax-string')).toHaveText('"first"');
    await panel.getByRole('tab', { name: 'Files', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'common.ts', exact: true })).toBeVisible();
    await close();
    release();
    await expect(page.locator('.message.assistant')).toHaveText('First workspace finished');
    await nav.getByRole('button', { name: 'Collapse workspace workspace', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'nested', exact: true })).toBeHidden();
    const search = page.getByRole('searchbox', { name: 'Search workspaces and conversations' });
    await search.fill('child workspace');
    await expect(nav.getByRole('button', { name: 'Start in the child workspace', exact: true })).toBeVisible();
    await search.clear();
    await page.reload();
    await expect(nav.getByRole('button', { name: 'nested', exact: true })).toBeHidden();
  } finally { release(); await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
