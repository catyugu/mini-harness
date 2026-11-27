import { expectPresent } from '../support/required.ts';
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { checkpointFixture, createFixturePaths, createMockProvider } from '../support/mock-provider.ts';
import { join } from 'node:path';
import { writeJson } from '@mini-harness/platform/json';
import { startIsolatedHost } from '../support/browser.ts';
import { writePlugin } from '../support/plugin-fixture.ts';

test('renders Markdown, tool output and checkpoint records in history', async ({ page }) => {
  const mock = await createMockProvider(async ({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model message');
    if (last.content.startsWith('Add latest notes')) return 'Added notes';
    if (last.content.startsWith('Write a continuation checkpoint')) return checkpointFixture;
    if (last.role === 'user')
      return {
        tool: 'ls',
        args: { path: '.' },
        text: 'Checking the workspace',
        thinking: last.content.startsWith('Show a result') ? 'Inspect the workspace first.' : undefined,
        callId: 'reused-tool',
      };
    return '### Workspace\n\n```text\nExample\n```\n\n<img src=x onerror="alert(1)">\n\n<p class="overlay">A tool note</p>';
  });
  const { root, paths } = createFixturePaths(mock.url);
  writeFileSync(join(paths.cwd, 'sample.txt'), 'A second tool result');
  const folder = writePlugin(
    paths.plugins,
    'bad-renderer',
    {},
    `
export const inject = ["harnessSessions"];
export const apply = (ctx) => {
      ctx.on("agent/tool-result", async (_content, { sessionId, tool }) => {
        if (tool === 'ls') await ctx.harnessSessions.records(sessionId, {
          pluginId: 'bad-renderer', instanceId: 'bad-renderer'
        }).append({}, { kind: 'progress', title: 'Tool progress record' });
      });
    };
`,
  );
  writeFileSync(
    join(folder, 'web.js'),
    `
export const inject = ["miniMessages"];

export const apply = (ctx) => {
      ctx.effect(() => ctx.miniMessages.registerTool('ls', (_tool, signal) => {
        document.body.dataset.activeFailedRenderers = String(Number(document.body.dataset.activeFailedRenderers ?? 0) + 1);
        signal.addEventListener('abort', () => {
          document.body.dataset.activeFailedRenderers = String(Number(document.body.dataset.activeFailedRenderers) - 1);
        }, { once: true });
        throw new Error('broken fixture tool renderer');
      }));
    };
`,
  );
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [{ id: 'bad-renderer', name: '../../plugins/bad-renderer', client: true }],
  });
  const failures: string[] = [],
    unhandled: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('broken fixture tool renderer'))
      failures.push(message.text());
  });
  page.on('pageerror', (error) => {
    unhandled.push(error.message);
  });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page
      .getByRole('textbox', { name: 'Message' })
      .fill('Show a result ' + 'Workspace notes. '.repeat(300));
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await expect(page.locator('.code-block code')).toHaveText('Example');
    await expect(page.locator('.message img, .message .overlay')).toHaveCount(0);
    await expect(page.getByText('A tool note')).toBeVisible();
    await expect(page.locator('.tool-card summary')).toContainText('ls');
    await expect(page.locator('.tool-card summary')).toContainText('Done');
    const reasoning = page.locator('.assistant-reasoning');
    const reasonHeader = reasoning.locator('summary');
    await expect(reasonHeader).toHaveText('Reasoning');
    await expect(reasoning.locator('p')).toBeHidden();
    await reasonHeader.click();
    await expect(reasoning.locator('p')).toHaveText('Inspect the workspace first.');
    await expect(reasoning.locator('p')).toBeVisible();
    await reasonHeader.click();
    await expect(reasoning.locator('p')).toBeHidden();
    expect(failures.length).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
    await expect(page.locator('body')).toHaveAttribute('data-active-failed-renderers', '0');

    const prompt = page.getByRole('textbox', { name: 'Message' });
    await prompt.fill('Add latest notes. ' + 'More workspace details. '.repeat(300));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Added notes', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'completed');
    await prompt.fill('  /compact  ');
    await prompt.press('Enter');
    const checkpoint = page.getByText('Context compacted', { exact: true });
    const checkpointHeading = page.getByRole('heading', { name: 'Goal and constraints' });
    await expect(checkpoint).toBeVisible();
    await expect(checkpointHeading).toBeHidden();
    await checkpoint.click();
    await expect(checkpointHeading).toBeVisible();
    await page.reload();
    await expect(checkpoint).toBeVisible();
    await checkpoint.click();
    await expect(checkpointHeading).toBeVisible();
  } finally {
    await page.close();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
    await mock.close();
  }
});

test('an active streamed response is restored when History remounts', async ({ page }) => {
  let releaseMore = () => {},
    finish = () => {};
  const more = new Promise<void>((resolve) => {
    releaseMore = resolve;
  });
  const end = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const paragraphs = Array.from({ length: 48 }, (_, index) => 'Paragraph ' + (index + 1)).join('\n\n');
  const mock = await createMockProvider(async function* () {
    yield 'Beginning ';
    await more;
    for (let count = 0; count < 2300; count++) yield 'x';
    yield ' through the window\n\n' + paragraphs;
    await end;
    yield '\n\nFinal paragraph';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const folder = join(paths.plugins, 'stream-observer');
  mkdirSync(folder);
  writeJson(join(folder, 'plugin.json'), {});
  writeFileSync(
    join(folder, 'web.js'),
    `
export const inject = ["miniConversation","miniSlots"];

export const apply = (ctx) => {
    const { miniConversation } = ctx;
      const remove = ctx.effect(() => ctx.miniSlots.register('conversation.history', (signal) => {
        const node = document.createElement('div');
        node.id = 'replacement-stream';
        const update = () => {
          const state = miniConversation.get();
          node.textContent = state.partial;
        };
        miniConversation.subscribe(['partial', 'history'], update, signal);
        update();
        return node;
      }, { key: 'history', priority: 1 }));
      window.addEventListener('restore-history', remove, { once: true, signal: ctx.fiber.signal });
    };
`,
  );
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [{ id: 'stream-observer', name: '../../plugins/stream-observer', client: true }],
  });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message' }).fill('Stream a long response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const streamed = page.locator('#replacement-stream');
    await expect(streamed).toContainText('Beginning');
    releaseMore();
    const expected = 'Beginning ' + 'x'.repeat(2300) + ' through the window';
    await expect(streamed).toHaveText(expected + '\n\n' + paragraphs);
    await page.evaluate(() => window.dispatchEvent(new Event('restore-history')));
    const history = page.locator('#messages');
    await expect(history.getByText('Paragraph 48', { exact: false })).toBeVisible();
    await history.hover();
    await page.mouse.wheel(0, -3000);
    await expect.poll(() => history.evaluate((node) => node.scrollTop)).toBeLessThan(8);
    finish();
    await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'completed');
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(history.getByText('Final paragraph', { exact: true })).toBeAttached();
    expect(await history.evaluate((node) => node.scrollTop)).toBeLessThan(8);
  } finally {
    releaseMore();
    finish();
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
