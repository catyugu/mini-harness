import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { checkpointFixture, createFixturePaths, createMockProvider } from '../support/mock-provider.ts';
import { settingsSection, startIsolatedHost } from '../support/browser.ts';

test('context settings and statistics stay usable at desktop and mobile widths', async ({ page }) => {
  const mock = await createMockProvider(({ messages }) => ({
    text: messages.at(-1)?.content.startsWith('Write a continuation checkpoint')
      ? checkpointFixture
      : 'Measured answer',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 80 },
    },
  }));
  const { paths, root } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'General').click();
    await expect(page.getByRole('switch', { name: 'Auto compaction' })).toHaveCount(0);
    await settingsSection(page, 'Context').click();
    await expect(page.getByRole('heading', { name: 'Context', exact: true })).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'Trigger threshold (%)' })).toHaveValue('80');
    await page.getByRole('button', { name: 'Close settings' }).click();

    const settings = page.getByRole('button', { name: 'Context settings', exact: true });
    const config = page.getByRole('dialog', { name: 'Context settings' });
    const auto = config.getByRole('switch', { name: 'Auto compaction' });
    await settings.click();
    await expect(auto).toBeChecked();
    await expect(config.getByRole('button', { name: 'Compact now' })).toHaveCount(0);
    await auto.uncheck();
    await config.getByRole('button', { name: 'Apply' }).click();
    await expect(auto).toBeEnabled();
    await page.keyboard.press('Escape');

    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Measure the conversation. '.repeat(40));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Measured answer', { exact: true })).toBeVisible();

    const status = page.getByLabel('Conversation statistics');
    await expect(status.getByRole('button', { name: 'Run statistics' })).toContainText('1 turn · 1 step');
    await expect(status.getByRole('button', { name: 'Token usage', exact: true })).toContainText(
      '120 tok · Cache 80%',
    );
    await page.getByRole('button', { name: 'Turn token usage' }).click();
    await expect(page.getByRole('dialog', { name: 'Turn token usage' })).toContainText('80 tok');
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 320, height: 720 });
    const dimensions = await status.evaluate((node) => ({
      scroll: node.scrollWidth,
      width: node.clientWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    const control = status.getByRole('button', { name: 'Context usage' });
    await control.click();
    const panel = page.getByRole('dialog', { name: 'Context usage' });
    await expect(panel.getByText('Input budget used', { exact: true })).toBeVisible();
    await expect(panel.getByText('Model window', { exact: true })).toBeVisible();
    await expect(panel.getByRole('switch')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await settings.click();
    await expect(auto).not.toBeChecked();
    await page.reload();
    await settings.click();
    await expect(auto).not.toBeChecked();
    await config.getByRole('button', { name: 'Restore defaults' }).click();
    await expect(auto).toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'Context').click();
    await expect(page.getByRole('spinbutton', { name: 'Trigger threshold (%)' })).toHaveValue('80');
    await page.getByRole('button', { name: 'All settings' }).click();
    await settingsSection(page, 'Built-in plugins').click();
    const plugin = page.getByRole('switch', { name: 'Context Management', exact: true });
    await plugin.uncheck();
    await expect(plugin).toBeEnabled();
    await expect(status).toHaveCount(0);
    await expect(settings).toHaveCount(0);
    await page.getByRole('button', { name: 'All settings' }).click();
    await expect(settingsSection(page, 'Context')).toHaveCount(0);
  } finally {
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
