import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { readJson, writeJson } from '../../src/config.js';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function startIsolatedHost(paths: ReturnType<typeof createFixturePaths>['paths']) {
  const port = await availablePort();
  const child: ChildProcess = spawn(process.execPath, [
    resolve('dist/bin/mini-harness.js'), '--cwd', paths.cwd, '--port', String(port)
  ], {
    env: { ...process.env, MINI_HARNESS_HOME: paths.home },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout?.on('data', (data) => { output += data.toString(); });
  child.stderr?.on('data', (data) => { output += data.toString(); });
  const pidPath = join(paths.home, 'server.json');
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(pidPath)) {
      const info = JSON.parse(readFileSync(pidPath, 'utf8'));
      if (info.pid === child.pid) {
        return {
          url: info.url as string,
          token: info.token as string,
          async stop() {
            if (child.exitCode === null) child.kill('SIGTERM');
            await new Promise<void>((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.once('close', () => resolve());
              setTimeout(resolve, 5000);
            });
          }
        };
      }
    }
    if (child.exitCode !== null) throw new Error('mini-harness exited: ' + output);
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill('SIGTERM');
  throw new Error('mini-harness did not start: ' + output);
}

test('desktop and mobile: send, navigate, settings and bulk select', async ({ browser }) => {
  const mock = await createMockProvider();
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const { root, paths } = createFixturePaths(mock.url);
      const service = await startIsolatedHost(paths);
      const page = await browser.newPage({ viewport });
      const events: string[] = [];
      page.on('pageerror', (error) => events.push(error.message));
      page.on('requestfailed', (req) => events.push(req.url() + ': ' + req.failure()?.errorText));
      try {
        await page.goto(service.url + '/#token=' + service.token);
        await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
        await page.getByRole('textbox', { name: 'Message' }).fill('Hello from the browser');
        await page.getByRole('button', { name: 'Send' }).click();
        try {
          await expect(page.locator('.message.assistant')).toHaveText('Mock response', { timeout: 15000 });
        } catch (error) {
          console.error('Browser state:', JSON.stringify({
            viewport, requests: mock.requests.length, events,
            location: page.url(),
            status: await page.locator('#status').textContent().catch(() => null),
            messages: await page.locator('#messages').textContent().catch(() => null)
          }));
          throw error;
        }

        if (viewport.width < 1000) await page.getByRole('button', { name: 'Toggle navigation' }).click();
        await page.getByRole('button', { name: 'Select', exact: true }).click();
        await page.getByRole('checkbox', { name: /Select Hello from the browser/ }).first().check();
        await expect(page.getByText('1 selected')).toBeVisible();
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('button', { name: 'Settings' }).click();
        await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
        await expect(page.getByRole('checkbox', { name: /Shell/ })).not.toBeChecked();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const dialog = await page.locator('#settingsPanel').boundingBox();
        expect(dialog.x).toBeGreaterThanOrEqual(0);
        expect(dialog.x + dialog.width).toBeLessThanOrEqual(viewport.width);
        await page.getByRole('button', { name: 'Close settings' }).click();
      } finally {
        await page.close();
        await service.stop();
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    await mock.close();
  }
});

test('refresh and navigation preserve a run while another conversation completes', async ({ browser }) => {
  for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    let entered: () => void, release: () => void;
    const waiting = new Promise<void>((done) => { entered = done; });
    const held = new Promise<void>((done) => { release = done; });
    const mock = await createMockProvider(async ({ messages }) => {
      if (messages.at(-1).content === 'Keep working') { entered(); await held; return 'Continued after refresh'; }
      return 'Independent reply';
    });
    const { root, paths } = createFixturePaths(mock.url);
    const service = await startIsolatedHost(paths);
    const page = await browser.newPage({ viewport });
    const openSidebar = async () => { if (viewport.width < 860) await page.getByRole('button', { name: 'Toggle navigation' }).click(); };
    try {
      await page.goto(service.url + '/#token=' + service.token);
      await page.getByRole('textbox', { name: 'Message' }).fill('Keep working');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await waiting;
      await page.reload();
      await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
      await openSidebar();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByLabel('Theme', { exact: true }).selectOption('dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.getByLabel('Parallel children', { exact: true }).fill('2');
      await page.getByRole('button', { name: 'Save settings' }).click();
      await expect(page.locator('#settingsStatus')).toHaveText('Saved.');
      await page.getByRole('button', { name: 'Close settings' }).click();
      await openSidebar();
      await page.getByRole('button', { name: /New conversation/ }).click();
      await page.getByRole('textbox', { name: 'Message' }).fill('Second conversation');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.message.assistant')).toHaveText('Independent reply');
      await openSidebar();
      await expect(page.getByRole('button', { name: 'Keep working', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Keep working', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
      release();
      await expect(page.locator('.message.assistant')).toHaveText('Continued after refresh');
      await expect(page.locator('.message.user')).toHaveCount(1);
      expect(mock.requests).toHaveLength(2);
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      release(); await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true });
    }
  }
});

test('plugin schema controls, recursive tree navigation, batch export and permanent deletion', async ({ page }) => {
  const mock = await createMockProvider(({ messages }) => {
    const last = messages.at(-1);
    if (last.role === 'tool') return 'Delegation complete';
    if (last.content === 'Parent task') return { tool: 'delegate', args: { task: 'Child task' } };
    if (last.content === 'Child task') return { tool: 'delegate', args: { task: 'Leaf task' } };
    return 'Leaf result';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const settings = readJson<any>(paths.settings, {});
  writeJson(paths.settings, { ...settings, subagents: { maxDepth: 2, maxParallel: 1 } });
  const folder = join(paths.plugins, 'example');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ title: 'Example', configSchema: {
    type: 'object', required: ['prefix', 'count', 'mode'], additionalProperties: false,
    properties: {
      prefix: { type: 'string', title: 'Prefix', default: 'Count' },
      count: { type: 'integer', title: 'Count', minimum: 1, maximum: 9, default: 3 },
      mode: { type: 'string', title: 'Mode', enum: ['brief', 'full'], default: 'brief' },
      enabled: { type: 'boolean', title: 'Enabled', default: true },
      limits: { type: 'object', title: 'Limits', properties: { threshold: { type: 'number', title: 'Threshold', default: 0.5 } } },
      tags: { type: 'array', title: 'Tags', items: { type: 'string' }, default: ['base'] }
    }
  } }));
  writeFileSync(join(folder, 'plugin.js'), 'export default (ctx, api) => { if (api.config.prefix === "bad") throw new Error("Bad prefix"); };');
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Example', exact: true }).check();
    await page.getByLabel('Prefix · example', { exact: true }).fill('Total');
    await page.getByLabel('Count · example', { exact: true }).fill('5');
    await page.getByLabel('Mode · example', { exact: true }).selectOption('"full"');
    await page.getByLabel('Enabled · example', { exact: true }).uncheck();
    await page.getByLabel('Threshold · example', { exact: true }).fill('0.75');
    await page.getByLabel('Tags · example', { exact: true }).fill('["custom"]');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.locator('#settingsStatus')).toHaveText('Saved.');
    expect(readJson<any>(paths.settings, {}).pluginConfig.example).toEqual({ prefix: 'Total', count: 5, mode: 'full', enabled: false,
      limits: { threshold: 0.75 }, tags: ['custom'] });
    await page.getByLabel('Prefix · example', { exact: true }).fill('bad');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.locator('#settingsStatus')).toContainText('Bad prefix');
    expect(readJson<any>(paths.settings, {}).pluginConfig.example.prefix).toBe('Total');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Parent task');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Delegation complete');
    await page.getByRole('button', { name: 'Expand Parent task', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Child task', exact: true }).click();
    await page.getByRole('button', { name: 'Leaf task', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Leaf result');
    await page.reload();
    await expect(page.locator('#conversationTitle')).toHaveText('Leaf task');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select Parent task', exact: true }).check();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exported = JSON.parse(readFileSync(await (await download).path(), 'utf8'));
    expect(exported.sessions).toHaveLength(3);
    expect(exported.sessions.every((item) => item.piSession.includes('"type":"message"'))).toBe(true);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.session-row')).toHaveCount(0);
    expect(readJson<any>(paths.registry, {}).sessions).toHaveLength(0);
  } finally {
    await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('renders Markdown and tool results, and stops a pending reply', async ({ page }) => {
  let markWaiting: () => void;
  let release: () => void;
  const waiting = new Promise<void>((done) => { markWaiting = done; });
  const delayed = new Promise<void>((done) => { release = done; });
  const mock = await createMockProvider(async ({ messages }) => {
    const last = messages.at(-1);
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
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
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

test('the global recent model survives history navigation and page reload', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const models = readJson<any>(join(paths.home, 'models.json'), {});
  models.providers['local-mock'].models.push({ ...models.providers['local-mock'].models[0], id: 'second-model', name: 'Second Model' });
  writeJson(join(paths.home, 'models.json'), models);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message' }).fill('Old model conversation');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('local-mock/second-model');
    await page.getByRole('button', { name: /New conversation/ }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('New model conversation');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    expect(mock.requests.at(-1).model).toBe('second-model');
    await page.getByRole('button', { name: 'Old model conversation', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('local-mock/second-model');
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('local-mock/second-model');
    await page.getByRole('textbox', { name: 'Message' }).fill('Use the recent model');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    expect(mock.requests.at(-1).model).toBe('second-model');
  } finally {
    await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true });
  }
});
