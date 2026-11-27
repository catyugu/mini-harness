import { expectPresent } from '../support/required.ts';
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { checkpointFixture, createFixturePaths, createMockProvider } from '../support/mock-provider.ts';
import { join } from 'node:path';
import { writeJson } from '@mini-harness/platform/json';
import { settingsSection, startIsolatedHost } from '../support/browser.ts';
import { writePlugin } from '../support/plugin-fixture.ts';

test('renders Markdown and tool results, and stops a pending reply', async ({ page }) => {
  let markWaiting: () => void;
  let release: () => void = () => {
    throw new Error('Not started');
  };
  const waiting = new Promise<void>((done) => {
    markWaiting = done;
  });
  const delayed = new Promise<void>((done) => {
    release = done;
  });
  let resumeSteering = () => {};
  const steering = new Promise<void>((done) => {
    resumeSteering = done;
  });
  const mock = await createMockProvider(async ({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model message');
    if (last.content === 'Stop this response') {
      markWaiting();
      await delayed;
      return 'Late response';
    }
    if (last.content === 'Steer this response') {
      await steering;
      return { tool: 'ls', args: { path: '.' } };
    }
    if (last.content === 'Change course') return 'Steering accepted';
    if (last.content === 'Stop this tool') return { tool: 'wait_for_stop', args: {} };
    if (last.content.startsWith('Write a continuation checkpoint')) return checkpointFixture;
    if (last.content === 'Reuse the tool ID')
      return { tool: 'read', args: { path: 'sample.txt' }, callId: 'reused-tool' };
    if (last.role === 'tool' && last.content === 'A second tool result') return 'The second tool finished';
    if (last.role === 'user')
      return {
        tool: 'ls',
        args: { path: '.' },
        text: 'Checking the workspace',
        thinking: last.content === 'Show a result' ? 'Inspect the workspace first.' : undefined,
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
export const inject = ["harnessSessions", "harnessTools"];
export const apply = (ctx) => {
      ctx.effect(() => ctx.harnessTools.register({
        name: "wait_for_stop", description: "Wait until cancelled", parameters: { type: "object", properties: {} },
        async execute(_args, { signal }) {
          signal.throwIfAborted();
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        }
      }));
      ctx.on("agent/tool-result", async (_content, { sessionId, tool }) => {
        if (tool === 'ls') await ctx.harnessSessions.records(sessionId, {
          pluginId: 'bad-renderer', instanceId: 'bad-renderer'
        }).append({}, { kind: 'progress', title: 'Tool progress record' });
      });
      ctx.on("agent/prepare-input", async (_content, { original, signal }) => {
        if (original.userText !== 'Stop before acceptance') return;
        signal.throwIfAborted();
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      });
    };
`,
  );
  writeFileSync(
    join(folder, 'web.js'),
    `
export const inject = ["miniMessages"];

export const apply = (ctx) => {
      ctx.effect(() => ctx.miniMessages.registerAction({
        id: 'review-turn', label: 'Review turn', icon: 'copy',
        visible: ({ target }) => target.type === 'assistant-turn' && target.messages.length > 1,
        run: ({ target, sessionId }) => {
          document.body.dataset.turn = JSON.stringify({
            id: target.id, first: target.messages[0].id, last: target.messages.at(-1).id,
            sessionId, rawText: target.rawText
          });
        }
      }));
      ctx.effect(() => ctx.miniMessages.registerTool('ls', (_tool, signal) => {
        document.body.dataset.activeFailedRenderers = String(Number(document.body.dataset.activeFailedRenderers ?? 0) + 1);
        signal.addEventListener('abort', () => {
          document.body.dataset.activeFailedRenderers = String(Number(document.body.dataset.activeFailedRenderers) - 1);
        }, { once: true });
        throw new Error('broken fixture tool renderer');
      }, 'body', 1));
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
    await page.getByRole('textbox', { name: 'Message' }).fill('Show a result');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await expect(page.locator('.code-block code')).toHaveText('Example');
    await expect(
      page.locator('.code-block').getByRole('button', { name: 'Copy', exact: true }),
    ).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const turn = page.locator('.assistant-turn');
    await turn.getByRole('button', { name: 'Copy message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toHaveAttribute(
      'aria-label',
      'Copied',
    );
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n?/g, '\n');
    expect(copied).toMatch(/^Checking the workspace/);
    expect(copied).not.toContain('(empty directory)');
    await expect(turn).toHaveCount(1);
    await expect(
      turn.locator(':scope > .message, :scope > .conversation-record, :scope > .tool-card'),
    ).toHaveText([
      /Reasoning.*Inspect the workspace first/s,
      'Checking the workspace',
      'Tool progress record',
      /ls.*Done/s,
      /Workspace.*Example.*A tool note/s,
    ]);
    await expect(turn.locator('.message-actions time')).toHaveCount(1);
    await turn.getByRole('button', { name: 'Review turn' }).click();
    const target = JSON.parse(
      expectPresent(await page.locator('body').getAttribute('data-turn'), 'plugin action target'),
    );
    expect(target.id).toBe(target.first);
    expect(target.id).not.toBe(target.last);
    expect(target.sessionId).toMatch(/^[a-f0-9-]+$/);
    expect(target.rawText).toBe(copied);
    expect(copied).toMatch(/```text[ \t]*\nExample[ \t]*\n```/);
    await expect(page.locator('.message img, .message .overlay')).toHaveCount(0);
    await expect(page.getByText('A tool note')).toBeVisible();
    await expect(page.locator('.tool-card summary')).toHaveAccessibleName(/ls.*\..*Done/);
    const reasoning = turn.locator('.assistant-reasoning');
    const reasonHeader = reasoning.locator('summary');
    const toolHeader = turn.locator('.tool-card summary');
    await expect(reasonHeader).toHaveText('Reasoning');
    await expect(reasonHeader.locator('svg')).toHaveCount(1);
    for (const header of [reasonHeader, toolHeader]) {
      expect(
        await header.evaluate((node) => {
          const turn = node.closest('.assistant-turn');
          if (!turn) throw new Error('Missing assistant turn');
          return node.getBoundingClientRect().left - turn.getBoundingClientRect().left;
        }),
      ).toBe(0);
    }
    await expect(reasoning.locator('p')).toBeHidden();
    await reasonHeader.click();
    await expect(reasoning.locator('p')).toHaveText('Inspect the workspace first.');
    await expect(reasoning.locator('p')).toBeVisible();
    await reasonHeader.click();
    await expect(reasoning.locator('p')).toBeHidden();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.length).toBeLessThanOrEqual(4);
    expect(unhandled).toEqual([]);
    await expect(page.locator('body')).toHaveAttribute('data-active-failed-renderers', '0');

    await page.getByRole('textbox', { name: 'Message' }).fill('Stop this response');
    await page.getByRole('button', { name: 'Send' }).click();
    await waiting;
    const viewport = expectPresent(page.viewportSize(), 'viewport');
    await page.setViewportSize({ width: 320, height: 720 });
    const stop = page.getByRole('button', { name: 'Stop response' });
    await expect(stop).toBeInViewport({ ratio: 0.99 });
    await stop.click();
    await page.setViewportSize(viewport);
    await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'cancelled');
    await expect(page.locator('.message.error')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    const requests = mock.requests.length;
    const prompt = page.getByRole('textbox', { name: 'Message' });
    await prompt.fill('Stop before acceptance');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'cancelled');
    await expect(prompt).not.toContainText('Stop before acceptance');
    await expect(page.locator('#queuedMessages')).toContainText('Stop before acceptance');
    await page.getByRole('button', { name: 'Cancel queued message: Stop before acceptance' }).click();
    expect(mock.requests.length).toBe(requests);
    await expect(page.getByText(/^Run cancelled/)).toHaveCount(2);
    await page.reload();
    await expect(page.getByText(/^Run cancelled/)).toHaveCount(2);
    await expect(page.locator('.assistant-turn .message-actions time')).toHaveCount(1);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'General').click();
    const mode = page.getByRole('combobox', { name: 'Default sending mode' });
    await mode.selectOption('steer');
    await expect(mode).toBeEnabled();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await prompt.fill('Steer this response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    await prompt.fill('Change course');
    await page.getByRole('button', { name: 'Send with Steer', exact: true }).click();
    await expect(page.locator('#queuedMessages')).toContainText('Change course');
    resumeSteering();
    const skipped = page.locator('.tool-card[data-state=skipped]');
    await expect(skipped.locator('summary')).toContainText('Skipped');
    await expect(page.getByText('Steering accepted', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'completed');
    await page.reload();
    await expect(skipped.locator('summary')).toContainText('Skipped');
    await expect(page.locator('.tool-card[data-state=finished]')).toHaveCount(1);
    await expect(page.getByText(/^Run cancelled/)).toHaveCount(2);

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
    await prompt.fill('Reuse the tool ID');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('The second tool finished', { exact: true })).toBeVisible();
    const finishedTools = page.locator('.tool-card[data-state=finished]');
    await expect(finishedTools.locator('summary strong')).toHaveText(['ls', 'read']);
    await finishedTools.first().locator('summary').click();
    await expect(finishedTools.first().locator('.tool-content')).toContainText('sample.txt');
    await expect(finishedTools.last()).not.toHaveAttribute('open', '');
    await page.reload();
    await expect(finishedTools.locator('summary strong')).toHaveText(['ls', 'read']);
    await expect(finishedTools.last().locator('summary')).toHaveAccessibleName(/read.*sample\.txt.*Done/);

    await prompt.fill('Stop this tool');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.tool-card[data-state=running] summary')).toHaveAccessibleName(
      /wait for stop.*Running/,
    );
    await page.getByRole('button', { name: 'Stop response' }).click();
    const cancelled = page.locator('.tool-card[data-state=cancelled]');
    await expect(cancelled.locator('.tool-state')).toHaveText('Cancelled');
    await page.reload();
    await expect(cancelled.locator('.tool-state')).toHaveText('Cancelled');
  } finally {
    release();
    resumeSteering();
    await page.close();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
    await mock.close();
  }
});

test('a long response updates only its view and restores from current state when History remounts', async ({
  page,
}) => {
  let releaseMore = () => {},
    releaseMarkdown = () => {},
    releaseTail = () => {},
    finish = () => {};
  const more = new Promise<void>((resolve) => {
    releaseMore = resolve;
  });
  const markdown = new Promise<void>((resolve) => {
    releaseMarkdown = resolve;
  });
  const tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  const end = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const paragraphs = Array.from({ length: 48 }, (_, index) => 'Paragraph ' + (index + 1)).join('\n\n');
  const section = (index: number) =>
    [
      '## Report section ' + index,
      '',
      'A structured report describes observations, evidence and implementation decisions. '.repeat(6),
      '',
      '- Inspect the source',
      '- Verify the outcome',
      '',
      '```text',
      'Example output',
      '```',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| Result | Accepted |',
      '',
    ].join('\n');
  const report = Array.from({ length: 90 }, (_, index) => section(index + 1)).join('\n');
  expect(Buffer.byteLength(report)).toBeGreaterThan(50 * 1024);
  const mock = await createMockProvider(async function* () {
    yield 'Beginning ';
    await more;
    for (let count = 0; count < 2300; count++) yield 'x';
    yield ' through the window\n\n' + paragraphs;
    await markdown;
    yield '\n\n### Streamed heading\n\n**bo';
    yield 'ld** and `inline`\n\n1. First step\n2. Second step\n\n';
    yield '```text\nStreaming code\n```\n\n| Key | Value |\n| --- | --- |\n| One | Two |\n\n';
    yield '<img src=x onerror="alert(1)">\n\n<p class="overlay">Safe text</p>\n\n';
    for (let offset = 0; offset < report.length; offset += 83) {
      yield report.slice(offset, offset + 83);
      // Pace bursts across browser frames instead of delivering the entire report in one event-loop turn.
      if (offset % (83 * 16) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    await tail;
    yield '\n\nFinal paragraph';
    await end;
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
    const signal = ctx.fiber.signal;
      miniConversation.subscribe(['history'], () => {
        if (miniConversation.get()?.history?.timeline.length ?? 0) throw new Error('broken history subscriber');
      }, signal);
      const remove = ctx.effect(() => ctx.miniSlots.register('conversation.history', (signal) => {
        const node = document.createElement('div');
        node.id = 'replacement-stream';
        const update = () => {
          const state = miniConversation.get();
          node.textContent = state.partial;
          node.dataset.messages = String(state?.history?.timeline.length ?? 0);
          node.dataset.events = String(Object.hasOwn(state, 'events'));
        };
        miniConversation.subscribe(['partial', 'history'], update, signal);
        update();
        return node;
      }, { key: 'history', priority: 1 }));
      window.addEventListener('restore-history', remove, { once: true, signal: signal });
    };
`,
  );
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [{ id: 'stream-observer', name: '../../plugins/stream-observer', client: true }],
  });
  const reported: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('broken history subscriber'))
      reported.push(message.text());
  });
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
        document.body.dataset.unrelatedUpdates = String(
          Number(document.body.dataset.unrelatedUpdates) + records.length,
        );
      });
      for (const selector of ['#composer', '#queuedMessages', '#welcome']) {
        const element = document.querySelector(selector);
        if (element)
          observer.observe(element, {
            attributes: true,
            subtree: true,
            childList: true,
            characterData: true,
          });
      }
    });
    releaseMore();
    const expected = 'Beginning ' + 'x'.repeat(2300) + ' through the window';
    await expect(streamed).toHaveText(expected + '\n\n' + paragraphs);
    await expect(streamed).toHaveAttribute('data-messages', '1');
    await expect(streamed).toHaveAttribute('data-events', 'false');
    await expect(page.locator('body')).toHaveAttribute('data-unrelated-updates', '0');
    await page.evaluate(() => window.dispatchEvent(new Event('restore-history')));
    const history = page.locator('#messages');
    const distanceFromEnd = () =>
      history.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
    await expect(history.getByText('Paragraph 48', { exact: false })).toBeVisible();
    await expect.poll(distanceFromEnd).toBeLessThan(8);
    await page.reload();
    await expect(page.locator('#replacement-stream')).toContainText('Paragraph 48');
    await page.evaluate(() => window.dispatchEvent(new Event('restore-history')));
    await expect.poll(distanceFromEnd).toBeLessThan(8);
    const previous = expectPresent(await page.locator('.message.user').elementHandle(), 'existing message');
    const preview = history.locator('.message.assistant');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const before = await cdp.send('Performance.getMetrics');
    releaseMarkdown();
    await expect(preview.getByRole('heading', { name: 'Streamed heading' })).toBeAttached();
    await expect(preview.locator('strong').first()).toHaveText('bold');
    await expect(preview.locator('p > code')).toHaveText('inline');
    await expect(preview.locator('ol > li')).toHaveText(['First step', 'Second step']);
    await expect(preview.locator('pre > code').first()).toHaveText('Streaming code');
    await expect(preview.getByRole('table').first()).toContainText('One');
    const prompt = page.getByRole('textbox', { name: 'Message' });
    await prompt.fill('Draft during streaming');
    await expect(prompt).toHaveText('Draft during streaming');
    await prompt.fill('');
    await expect(preview.getByRole('heading', { name: 'Report section 90' })).toBeAttached();
    await expect(preview.locator('img, .overlay')).toHaveCount(0);
    await expect(preview.getByText('Safe text')).toBeAttached();
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeEnabled();
    await expect.poll(distanceFromEnd).toBeLessThan(8);
    expect(await previous.evaluate((node) => node.isConnected)).toBe(true);
    const after = await cdp.send('Performance.getMetrics');
    const metrics = ['TaskDuration', 'ScriptDuration', 'LayoutDuration'].map((name) => {
      const value = (sample: typeof before) => sample.metrics.find((metric) => metric.name === name)!.value;
      return name + '=' + (value(after) - value(before)).toFixed(3) + 's';
    });
    console.log('50 KB native Markdown stream: ' + metrics.join(', '));
    await cdp.detach();
    await history.hover();
    await page.mouse.wheel(0, -100000);
    await expect.poll(() => history.evaluate((node) => node.scrollTop)).toBeLessThan(8);
    releaseTail();
    await expect(preview.getByText('Final paragraph', { exact: true })).toBeAttached();
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeEnabled();
    expect(await history.evaluate((node) => node.scrollTop)).toBeLessThan(8);
    const liveHtml = await preview.innerHTML();
    finish();
    await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'completed');
    await expect(preview).toHaveJSProperty('innerHTML', liveHtml);
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(history.getByText('Final paragraph', { exact: true })).toBeAttached();
    expect(await history.evaluate((node) => node.scrollTop)).toBeLessThan(8);
    await page.reload();
    await expect(page.locator('#replacement-stream')).toBeAttached();
    await page.evaluate(() => window.dispatchEvent(new Event('restore-history')));
    await expect(history.getByText('Final paragraph', { exact: true })).toBeInViewport();
    await expect.poll(distanceFromEnd).toBeLessThan(8);
  } finally {
    releaseMore();
    releaseMarkdown();
    releaseTail();
    finish();
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('built-in tool views distinguish calls and retain their content after replay', async ({ page }) => {
  const longPath = 'missing/' + 'long-path/'.repeat(60) + 'sample.txt';
  const calls: { tool: string; args: Record<string, unknown>; summary: RegExp; output: string }[] = [
    {
      tool: 'read',
      args: { path: 'sample.txt', offset: 1, limit: 2 },
      summary: /read.*sample\.txt.*offset 1.*limit 2.*Done/,
      output: 'original text',
    },
    {
      tool: 'edit',
      args: { path: 'sample.txt', edits: [{ oldText: 'original text', newText: 'updated text' }] },
      summary: /edit.*sample\.txt.*Done/,
      output: 'Applied 1 edit',
    },
    {
      tool: 'find',
      args: { pattern: '*.txt' },
      summary: /find.*\*\.txt.* in \..*Done/,
      output: 'sample.txt',
    },
    {
      tool: 'grep',
      args: { pattern: 'updated', path: '.', glob: '*.txt' },
      summary: /grep.*updated.* in \..*\*\.txt.*Done/,
      output: 'updated text',
    },
    {
      tool: 'load_skill',
      args: { name: 'fixture-review' },
      summary: /load skill.*fixture-review.*Done/,
      output: 'Review the fixture carefully.',
    },
    {
      tool: 'read_context',
      args: { entry: 'abcdef1234567890', offset: 0, limit: 128 },
      summary: /read context.*abcdef1234567890.*offset 0.*limit 128.*Failed/,
      output: 'Original message not found',
    },
    { tool: 'task_control', args: { action: 'list' }, summary: /task control.*list.*Done/, output: '[]' },
    {
      tool: 'send_message',
      args: { sessionId: 'missing-child', message: 'Follow-up for child' },
      summary: /send message.*missing-child.*Follow-up for child.*Failed/,
      output: 'Choose a direct parent or child conversation',
    },
    {
      tool: 'read',
      args: { path: longPath },
      summary: /read.*missing\/long-path\/.*sample\.txt.*Failed/,
      output: longPath,
    },
  ];
  let index = 0;
  const mock = await createMockProvider(({ messages }) => {
    if (messages.at(-1)?.role === 'tool') return 'Call finished';
    const { tool, args } = expectPresent(calls[index++], 'next fixture call');
    return { tool, args };
  });
  const { root, paths } = createFixturePaths(mock.url);
  writeFileSync(join(paths.cwd, 'sample.txt'), 'original text');
  const skill = join(paths.home, 'skills', 'fixture-review');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: fixture-review\ndescription: Review a fixture\n---\nReview the fixture carefully.',
  );
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    const prompt = page.getByRole('textbox', { name: 'Message' });
    const cards = page.locator('.tool-card');
    for (const [i, call] of calls.entries()) {
      await prompt.fill('Tool view ' + (i + 1));
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(cards).toHaveCount(i + 1);
      const card = cards.nth(i);
      const header = card.locator('summary').first();
      await expect(header).toHaveAccessibleName(call.summary);
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
      await header.click();
      const body = card.locator('.tool-content');
      await expect(body).toContainText(call.output);
      if (call.tool === 'edit') {
        await expect(body.getByLabel('Before')).toHaveText('original text');
        await expect(body.getByLabel('After')).toHaveText('updated text');
      }
      await header.click();
    }
    await page.reload();
    await expect(cards).toHaveCount(calls.length);
    for (const [i, call] of calls.entries())
      await expect(cards.nth(i).locator('summary').first()).toHaveAccessibleName(call.summary);
    await page.setViewportSize({ width: 320, height: 844 });
    const header = cards.last().locator('summary').first();
    await expect(header).toHaveAccessibleName(calls.at(-1)!.summary);
    await expect
      .poll(() =>
        header.evaluate((node) => {
          const row = node.getBoundingClientRect();
          const status = node.querySelector('.tool-state')!.getBoundingClientRect();
          const duration = node.querySelector('.tool-duration')!.getBoundingClientRect();
          const summary = node.querySelector<HTMLElement>('.file-tool-target');
          return (
            status.right <= row.right + 1 &&
            duration.right <= status.left + 1 &&
            !!summary &&
            summary.scrollWidth > summary.clientWidth
          );
        }),
      )
      .toBe(true);
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
