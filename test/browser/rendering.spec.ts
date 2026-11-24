import { expectPresent } from '../support/required.js';
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { join } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { startIsolatedHost } from '../support/browser.js';

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
  const folder = join(paths.plugins, 'bad-renderer');
  mkdirSync(folder);
  writeJson(join(folder, 'plugin.json'), { browserInject: ['miniMessages'] });
  writeFileSync(join(folder, 'web.js'), `import { conversationExtensions } from '/packages/ui-runtime/plugin-sdk.js';
    export default (_ctx, api) => {
      api.contribute(conversationExtensions.tool, 'ls', () => { throw new Error('broken fixture tool renderer'); });
    };`);
  writeJson(paths.settings, { ...readJson(paths.settings, {}), plugins: { 'bad-renderer': true } });
  const failures: string[] = [], unhandled: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error' && message.text().includes('broken fixture tool renderer')) failures.push(message.text()); });
  page.on('pageerror', (error) => { unhandled.push(error.message); });
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
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n?/g, '\n');
    expect(copied).toMatch(/```text[ \t]*\nExample[ \t]*\n```/);
    await expect(page.locator('.message img, .message .overlay')).toHaveCount(0);
    await expect(page.getByText('A tool note')).toBeVisible();
    await expect(page.locator('.tool-card summary')).toContainText('ls');
    await expect(page.locator('.tool-card summary')).toContainText('Done');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.length).toBeLessThanOrEqual(4);
    expect(unhandled).toEqual([]);

    await page.getByRole('textbox', { name: 'Message' }).fill('Stop this response');
    await page.getByRole('button', { name: 'Send' }).click();
    await waiting;
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'cancelled');
    await expect(page.locator('.message.error')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  } finally {
    release();
    await page.close();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
    await mock.close();
  }
});

test('a long response updates only its view and restores from current state when History remounts', async ({ page }) => {
  let releaseMore = () => {}, finish = () => {};
  const more = new Promise<void>((resolve) => { releaseMore = resolve; });
  const end = new Promise<void>((resolve) => { finish = resolve; });
  const mock = await createMockProvider(async function* () {
    yield 'Beginning ';
    await more;
    for (let count = 0; count < 2300; count++) yield 'x';
    yield ' through the window';
    await end;
  });
  const { root, paths } = createFixturePaths(mock.url);
  const folder = join(paths.plugins, 'stream-observer');
  mkdirSync(folder);
  writeJson(join(folder, 'plugin.json'), { browserInject: ['miniConversation', 'miniSlots'] });
  writeFileSync(join(folder, 'web.js'), `import { slotExtensions } from '/packages/ui-runtime/plugin-sdk.js';
    export default ({ miniConversation }, api) => {
      miniConversation.subscribe(['history'], () => {
        if (miniConversation.get().history.messages.length) throw new Error('broken history subscriber');
      }, api.signal);
      const remove = api.contribute(slotExtensions.keyed, 'conversation.history', 'history', (signal) => {
        const node = document.createElement('div');
        node.id = 'replacement-stream';
        const update = () => {
          const state = miniConversation.get();
          node.textContent = state.partial;
          node.dataset.messages = String(state.history.messages.length);
          node.dataset.events = String(Object.hasOwn(state, 'events'));
        };
        miniConversation.subscribe(['partial', 'history'], update, signal);
        update();
        return node;
      });
      window.addEventListener('restore-history', remove, { once: true, signal: api.signal });
    };`);
  writeJson(paths.settings, { ...readJson(paths.settings, {}), plugins: { 'stream-observer': true } });
  const reported: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error' && message.text().includes('broken history subscriber')) reported.push(message.text()); });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message' }).fill('Stream a long response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const streamed = page.locator('#replacement-stream');
    await expect(streamed).toContainText('Beginning');
    expect(reported.length).toBeGreaterThan(0);
    await page.evaluate(() => {
      document.body.dataset.unrelatedUpdates = '0';
      const observer = new MutationObserver((records) => {
        document.body.dataset.unrelatedUpdates = String(Number(document.body.dataset.unrelatedUpdates) + records.length);
      });
      for (const selector of ['#composer', '#queuedMessages', '#welcome']) {
        const element = document.querySelector(selector);
        if (element) observer.observe(element, { attributes: true, subtree: true, childList: true, characterData: true });
      }
    });
    releaseMore();
    const expected = 'Beginning ' + 'x'.repeat(2300) + ' through the window';
    await expect(streamed).toHaveText(expected);
    await expect(streamed).toHaveAttribute('data-messages', '1');
    await expect(streamed).toHaveAttribute('data-events', 'false');
    await expect(page.locator('body')).toHaveAttribute('data-unrelated-updates', '0');
    await page.evaluate(() => window.dispatchEvent(new Event('restore-history')));
    await expect(page.locator('.message.assistant')).toHaveText(expected);
    finish();
    await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'completed');
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toHaveText(expected);
  } finally {
    releaseMore();
    finish();
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
