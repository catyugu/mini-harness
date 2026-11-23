import { expectPresent } from '../../../test/support/required.js';
import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { startIsolatedHost } from '../../../test/support/browser.js';

test('renders Markdown and tool results, and stops a pending reply', async ({ page }) => {
  let markWaiting: () => void;
  let release: () => void = () => { throw new Error('Not started'); };
  const waiting = new Promise<void>((done) => { markWaiting = done; });
  const delayed = new Promise<void>((done) => { release = done; });
  const mock = await createMockProvider(async ({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model message');
    if (last.content === 'Stop this response') {
      markWaiting();
      await delayed;
      return 'Late response';
    }
    if (last.role === 'user') return { tool: 'ls', args: { path: '.' } };
    return '### Workspace\n\n```text\nExample\n```\n\n<img src=x onerror="alert(1)">\n\n<p class="overlay">A tool note</p>';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message' }).fill('Show a result');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await expect(page.locator('.code-block code')).toHaveText('Example');
    await expect(page.locator('.code-block').getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('.message-row.assistant .message-actions button').click();
    await expect(page.locator('.message-row.assistant .message-actions button')).toHaveAttribute('aria-label', 'Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('```text\nExample\n```');
    await expect(page.locator('.message img, .message .overlay')).toHaveCount(0);
    await expect(page.getByText('A tool note')).toBeVisible();
    await expect(page.locator('.tool-card summary')).toContainText('ls');
    await expect(page.locator('.tool-card summary')).toContainText('Done');

    await page.getByRole('textbox', { name: 'Message' }).fill('Stop this response');
    await page.getByRole('button', { name: 'Send' }).click();
    await waiting;
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect(page.locator('.message.error')).toContainText('Agent run cancelled');
  } finally {
    release();
    await page.close();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
    await mock.close();
  }
});
