import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { readJson, writeJson } from '@mini-harness/platform/config';
import { startIsolatedHost } from '../support/browser.js';

test('running messages can queue follow-ups and approve shell commands from the GUI', async ({ page }) => {
  let release: () => void = () => { throw new Error('Not started'); };
  let entered: () => void = () => { throw new Error('Not started'); };
  const held = new Promise<void>((done) => { release = done; }), waiting = new Promise<void>((done) => { entered = done; });
  const mock = await createMockProvider(async ({ messages }) => {
    if (messages.at(-1)?.content === 'Wait') { entered(); await held; return 'First reply'; }
    if (messages.at(-1)?.content === 'Shell task') return { tool: 'sandbox_shell', args: { command: 'echo approved' } };
    return 'Finished';
  });
  const { root, paths } = createFixturePaths(mock.url);
  writeJson(paths.settings, { ...readJson<any>(paths.settings, {}), plugins: { shell: true }, pluginConfig: { shell: { mode: 'host', timeoutSeconds: 60 } } });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Wait');
    await page.getByRole('button', { name: 'Send', exact: true }).click(); await waiting;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue');
    await page.getByRole('combobox', { name: 'While running', exact: true }).selectOption('followUp');
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(page.locator('#queuedMessages .queue-item > span')).toHaveText('Follow up: Continue');
    release();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.locator('#queuedMessages')).toBeHidden();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Shell task');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.approval-card pre')).toHaveText('echo approved');
    await expect(page.locator('.approval-card strong')).toHaveText('Shell approval');
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.locator('.approval-card')).toHaveCount(0);
    await page.locator('.tool-card summary').click();
    await expect(page.locator('.tool-arguments')).toContainText('echo approved');
    await expect(page.locator('.tool-content')).toContainText('Exit 0');
    expect(await page.locator('.tool-content').evaluate((node) =>
      [...node.children].findIndex((child) => child.classList.contains('tool-arguments')))).toBe(0);
    await expect(page.locator('.tool-duration')).toHaveText(/\d+ (ms|s)/);
    await expect(page.locator('.tool-exit-code')).toHaveText('Exit 0');
    await expect(page.locator('#runSummary')).toContainText('Completed');
    await page.reload();
    await expect(page.locator('.tool-exit-code')).toHaveText('Exit 0');
    await expect(page.locator('.tool-duration')).toHaveText(/\d+ (ms|s)/);
  } finally { release(); await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
