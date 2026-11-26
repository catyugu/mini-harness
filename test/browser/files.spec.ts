import { expectPresent } from '../support/required.ts';
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../support/mock-provider.ts';
import { startIsolatedHost, settingsSection, expectInViewport } from '../support/browser.ts';

test('file inspection, responsive themes and reduced viewport height keep controls reachable', async ({
  browser,
}) => {
  const markdown = [
    '# Visible file',
    '',
    'Workspace content',
    '',
    '\`\`\`text',
    'Readable code',
    '\`\`\`',
    '',
    '| Path | Script | Package | 命中数 |',
    '| --- | --- | --- | --- |',
    '| \`docs/examples/tsconfig.json\` | \`test:playwright\` | \`@mini-harness/plugin-api\` | 0 |',
  ].join('\n');
  const mock = await createMockProvider(() => markdown),
    { root, paths } = createFixturePaths(mock.url);
  const note = join(paths.cwd, 'notes.md');
  writeFileSync(note, '# Visible file\nBefore edits');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: paths.cwd });
  git('init', '--quiet');
  git('add', 'notes.md');
  writeFileSync(note, markdown);
  const service = await startIsolatedHost(paths);
  try {
    for (const width of [1920, 900, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      try {
        await page.goto(service.url + '/#token=' + service.token);
        const title = page.locator('#conversationTitle');
        await expect(title).toBeVisible();
        await expect.poll(async () => (await title.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(20);
        const header = expectPresent(await page.locator('.topbar').boundingBox(), 'header bounds');
        const meta = expectPresent(await page.locator('#headerMeta').boundingBox(), 'header meta bounds');
        expect(header.y + header.height - meta.y - meta.height).toBeGreaterThanOrEqual(12);
        if (width <= 860) {
          const navigation = page.getByRole('button', { name: 'Toggle navigation' });
          const close = page
            .getByRole('dialog', { name: 'Conversations' })
            .getByRole('button', { name: 'Close navigation' });
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
        await panel.getByRole('button', { name: /Workspace files/ }).click();
        await expect(panel.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
        const file = panel.getByRole('button', { name: 'notes.md', exact: true });
        expect(
          await file.evaluate((node) => {
            const image = node.querySelector('svg');
            if (!image) throw new Error('Missing file icon');
            return image.getBoundingClientRect().left - node.getBoundingClientRect().left;
          }),
        ).toBeLessThan(32);
        await file.click();
        await expect(panel.getByRole('heading', { name: 'Visible file' })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Diff', exact: true })).toHaveCount(0);
        await panel.getByRole('button', { name: 'Workspace panel home' }).click();
        await panel.getByRole('button', { name: /Git changes/ }).click();
        await panel.getByRole('button', { name: /^notes.md/ }).click();
        await expect(panel.locator('.diff')).toContainText('+Readable code');
        await expect(panel.getByRole('tab', { name: 'Diff: notes.md', exact: true })).toBeVisible();
        await panel.getByRole('tab', { name: 'notes.md', exact: true }).click();
        await expect(panel.getByRole('tab', { name: 'notes.md', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await expect(panel.getByRole('heading', { name: 'Visible file' })).toBeVisible();
        await panel.getByRole('button', { name: 'Source', exact: true }).click();
        await expect(panel.locator('.file-preview')).toContainText('Readable code');
        await panel.getByRole('button', { name: 'Source', exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expectInViewport(panel, { width, height: 700 });
        await panel.getByRole('button', { name: 'Close workspace panel' }).click();
        const prompt = page.getByRole('textbox', { name: 'Message', exact: true });
        await prompt.fill('Render this file');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        const summary = page.getByLabel('Latest run');
        await expect(summary).toHaveAttribute('data-state', 'completed');
        await expect(summary).toBeInViewport();
        await expect(page.locator('#conversationHistory')).toBeVisible();
        await expect
          .poll(() =>
            summary.evaluate((node) => {
              const history = document.getElementById('conversationHistory');
              const composer = document.querySelector('.composer-wrap');
              if (!history || !composer) throw new Error('Missing conversation layout');
              const run = node.getBoundingClientRect();
              return {
                afterHistory: run.top >= history.getBoundingClientRect().bottom - 1,
                beforeComposer: run.bottom <= composer.getBoundingClientRect().top + 1,
              };
            }),
          )
          .toEqual({ afterHistory: true, beforeComposer: true });
        for (const theme of ['dark', 'light', 'system']) {
          if (theme === 'system') await page.emulateMedia({ colorScheme: 'dark' });
          if (width <= 860) await page.getByRole('button', { name: 'Toggle navigation' }).click();
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
          await settingsSection(page, 'General').click();
          await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await page.getByRole('button', { name: 'Close settings' }).click();
          await page.getByRole('button', { name: 'Open workspace panel', exact: true }).click();
          for (const markdown of [page.locator('#messages .markdown').last(), panel.locator('.markdown')]) {
            await expect(markdown.locator('td code')).toHaveText([
              'docs/examples/tsconfig.json',
              'test:playwright',
              '@mini-harness/plugin-api',
            ]);
          }
          if (width <= 900)
            expect(
              await panel
                .locator('.markdown-table')
                .evaluate(
                  (node) =>
                    node.scrollWidth > node.clientWidth && getComputedStyle(node).overflowX === 'auto',
                ),
            ).toBe(true);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await panel.getByRole('button', { name: 'Close workspace panel' }).click();
        }
        await page.setViewportSize({ width, height: 380 });
        await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A long task '.repeat(100));
        const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
        expect(
          expectPresent(send, 'send button bounds').y + expectPresent(send, 'send button bounds').height,
        ).toBeLessThanOrEqual(380);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        await page.close();
      }
    }
  } finally {
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
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
