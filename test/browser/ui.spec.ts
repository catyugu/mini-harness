import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
    resolve('dist/bin/mini-harness.js'), '--no-open', '--cwd', paths.cwd, '--port', String(port)
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

const settingsSection = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true });
const modelButton = (page: Page) => page.locator('#modelSelect');
const modelSearch = (page: Page) => page.getByRole('combobox', { name: 'Search models' });
const suggestions = (page: Page) => page.getByRole('listbox', { name: 'Input suggestions' });

async function chooseModel(page: Page, query: string) {
  await modelButton(page).click();
  await modelSearch(page).fill(query);
  await expect(page.getByRole('listbox', { name: 'Configured models' }).getByRole('option')).toHaveCount(1);
  await modelSearch(page).press('Enter');
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
        const welcome = page.getByRole('heading', { name: 'What are we working on?' });
        await expect(welcome).toBeVisible();
        const title = await welcome.boundingBox(), composer = await page.locator('#composer').boundingBox();
        expect(composer.y - title.y).toBeLessThan(145);
        await expect(modelButton(page)).toHaveText('Mock Model');
        await modelButton(page).click();
        await expect(modelSearch(page)).toBeFocused();
        const modelPop = await page.locator('#modelPicker').boundingBox();
        expect(modelPop.x).toBeGreaterThanOrEqual(0);
        expect(modelPop.x + modelPop.width).toBeLessThanOrEqual(viewport.width);
        await modelSearch(page).press('Escape');
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
        await settingsSection(page, 'Plugins').click();
        await expect(page.getByRole('button', { name: 'Manage plugins', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Install plugin', exact: true })).toBeHidden();
        await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const dialog = await page.locator('#settingsPanel').boundingBox();
        expect(dialog.x).toBeGreaterThanOrEqual(0);
        expect(dialog.x + dialog.width).toBeLessThanOrEqual(viewport.width);
        if (viewport.width > 560) {
          expect(Math.abs(dialog.x - (viewport.width - dialog.width) / 2)).toBeLessThan(2);
          await page.getByRole('heading', { name: 'Plugins', exact: true }).click();
          await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
          await page.mouse.click(4, 4);
          await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
        } else {
          await expect(settingsSection(page, 'Plugins')).toBeHidden();
          await page.getByRole('button', { name: /All settings/ }).click();
          await expect(settingsSection(page, 'Plugins')).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
        }
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
      await settingsSection(page, 'Appearance').click();
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.getByRole('button', { name: 'Close settings' }).click();
      await openSidebar();
      await page.getByRole('button', { name: 'Browse plugins' }).click();
      await page.getByRole('button', { name: 'Subagents settings', exact: true }).click();
      await page.getByLabel('Parallel children · subagents', { exact: true }).fill('2');
      await page.getByRole('button', { name: 'Save configuration' }).click();
      await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
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
    await page.getByRole('button', { name: 'Browse plugins' }).click();
    await page.getByRole('switch', { name: 'Example', exact: true }).check();
    await page.getByRole('button', { name: 'Example settings', exact: true }).click();
    await page.getByLabel('Prefix · example', { exact: true }).fill('Total');
    await page.getByLabel('Count · example', { exact: true }).fill('5');
    await page.getByLabel('Mode · example', { exact: true }).selectOption('"full"');
    await page.getByLabel('Enabled · example', { exact: true }).uncheck();
    await page.getByLabel('Threshold · example', { exact: true }).fill('0.75');
    await page.getByLabel('Tags · example', { exact: true }).fill('["custom"]');
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByRole('region', { name: 'Plugin catalog' }).getByRole('status').filter({ hasText: /Saved|Bad prefix/ })).toHaveText('Saved.');
    expect(readJson<any>(paths.settings, {}).pluginConfig.example).toEqual({ prefix: 'Total', count: 5, mode: 'full', enabled: false,
      limits: { threshold: 0.75 }, tags: ['custom'] });
    await page.getByLabel('Prefix · example', { exact: true }).fill('bad');
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByRole('region', { name: 'Plugin catalog' }).getByRole('status').filter({ hasText: /Saved|Bad prefix/ })).toContainText('Bad prefix');
    expect(readJson<any>(paths.settings, {}).pluginConfig.example.prefix).toBe('Total');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Parent task');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Delegation complete');
    await page.getByRole('button', { name: 'Expand Parent task', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Child task', exact: true }).click();
    await page.getByRole('button', { name: 'Leaf task', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Leaf result');
    const ancestors = page.getByRole('navigation', { name: 'Parent conversations' });
    await expect(ancestors.getByRole('button')).toHaveText(['Parent task', 'Child task']);
    await ancestors.getByRole('button', { name: 'Child task', exact: true }).click();
    await expect(page.locator('#conversationTitle')).toHaveText('Child task');
    await page.getByRole('button', { name: 'Leaf task', exact: true }).click();
    await expect(page.locator('#conversationTitle')).toHaveText('Leaf task');
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
    await expect(page.locator('.code-block').getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('.message-row.assistant .message-actions button').click();
    await expect(page.locator('.message-row.assistant .message-actions button')).toHaveText('Copied');
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

test('the global recent model survives history navigation and page reload', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const models = readJson<any>(join(paths.home, 'models.json'), {});
  const first = models.providers['local-mock'].models[0];
  models.providers['local-mock'].models.push({ ...first, id: 'second-model', name: 'Second Model', reasoning: true });
  models.providers['unconfigured-fixture'] = { baseUrl: mock.url, api: 'openai-completions',
    models: [{ ...first, id: 'private-only', name: 'Private Only' }] };
  writeJson(join(paths.home, 'models.json'), models);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message' }).fill('Old model conversation');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await modelButton(page).click();
    await modelSearch(page).fill('private-only');
    await expect(page.getByText('No matching models.')).toBeVisible();
    await modelSearch(page).press('Escape');
    await chooseModel(page, 'local-mock second-model');
    await expect(modelButton(page)).toHaveText('Second Model');
    await page.reload();
    await expect(modelButton(page)).toHaveText('Mock Model');
    await chooseModel(page, 'second-model');
    await page.getByRole('button', { name: /New conversation/ }).click();
    await page.getByLabel('Thinking level').selectOption('high');
    await page.getByRole('textbox', { name: 'Message' }).fill('New model conversation');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    expect(mock.requests.at(-1).model).toBe('second-model');
    await expect(page.getByLabel('Thinking level')).toHaveValue('high');
    await page.getByRole('button', { name: 'Old model conversation', exact: true }).click();
    await expect(modelButton(page)).toHaveText('Second Model');
    await page.reload();
    await expect(modelButton(page)).toHaveText('Second Model');
    await page.getByRole('textbox', { name: 'Message' }).fill('Use the recent model');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    expect(mock.requests.at(-1).model).toBe('second-model');
  } finally {
    await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('drafts, search, rename, single deletion, attachment and input discovery', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  writeFileSync(join(paths.cwd, 'notes.md'), '# Notes\nTask details');
  mkdirSync(join(paths.cwd, 'task files'));
  writeFileSync(join(paths.cwd, 'task files', 'draft.md'), '# Draft');
  const skill = join(paths.skills, 'review'); mkdirSync(skill); writeFileSync(join(skill, 'SKILL.md'), '---\nname: review\ndescription: Review the work\n---\n\nReview carefully.');
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    const index = readJson<any>(paths.registry, { sessions: [] }); expect(index.sessions).toHaveLength(0);
    const draft = page.getByRole('textbox', { name: 'Message', exact: true });
    await draft.fill('@');
    await suggestions(page).getByRole('option', { name: 'task files, expand folder' }).click();
    await suggestions(page).getByRole('option', { name: 'draft.md', exact: true }).click();
    await expect(draft).toHaveValue('@"task files/draft.md" ');
    await draft.fill('@');
    await suggestions(page).getByRole('option', { name: 'task files, expand folder' }).click();
    await suggestions(page).getByRole('option', { name: 'Reference task files/', exact: true }).click();
    await expect(draft).toHaveValue('@"task files/" ');
    await draft.fill('@notes');
    await suggestions(page).getByRole('option', { name: 'notes.md', exact: true }).click();
    await expect(draft).toHaveValue('@"notes.md" ');

    await draft.fill('Read this attachment  and keep this text');
    await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(21, 21));
    await draft.press('/'); await draft.press('m'); await draft.press('o');
    await expect(suggestions(page).getByRole('option', { name: /Choose a configured model/ })).toBeVisible();
    await draft.press('Tab');
    await expect(draft).toHaveValue('Read this attachment /model and keep this text');
    await draft.press('Enter');
    await expect(modelSearch(page)).toBeFocused();
    await modelSearch(page).press('Escape');
    await expect(draft).toHaveValue('Read this attachment  and keep this text');

    await draft.fill('Open https://example.test/model and /home/model');
    await expect(suggestions(page)).toBeHidden();
    await draft.fill('Read this attachment  and keep this text');
    await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(21, 21));
    await draft.press('/'); await draft.press('r'); await draft.press('e'); await draft.press('v');
    await expect(suggestions(page).getByRole('option', { name: /Review the work/ })).toBeVisible();
    await draft.press('Enter');
    await expect(draft).toHaveValue('Read this attachment /skill:review and keep this text');
    await page.locator('#composer input[type=file]').setInputFiles({ name: 'task.txt', mimeType: 'text/plain', buffer: Buffer.from('ATTACHED TASK') });
    await expect(page.getByRole('button', { name: 'Remove task.txt' })).toBeVisible();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    expect(JSON.stringify(mock.requests[0])).toContain('ATTACHED TASK');
    expect(JSON.stringify(mock.requests[0])).toContain('Review carefully.');
    expect(JSON.stringify(mock.requests[0])).toContain('Read this attachment and keep this text');
    await draft.fill('/export');
    const exported = page.waitForEvent('download');
    await draft.press('Enter');
    expect((await exported).suggestedFilename()).toBe('mini-harness-sessions.json');
    await expect(page.locator('.attachment')).toHaveCount(0);
    await page.locator('.session-row').hover();
    await page.getByRole('button', { name: /^Rename .*Read this attachment|^Rename \/skill:review/ }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Project review');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.locator('#conversationTitle')).toHaveText('Project review');
    await page.getByRole('searchbox', { name: 'Search conversations' }).fill('absent');
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search conversations' }).fill('review');
    await expect(page.locator('#sessions .session-row')).toHaveCount(1);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete Project review', exact: true }).click();
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('frontend plugins own all five slots and clean up on disable and reconfiguration', async ({ page }) => {
  const mock = await createMockProvider(({ messages }) => messages.at(-1).role === 'tool' ? 'Done' : { tool: 'ls', args: {} });
  const { root, paths } = createFixturePaths(mock.url), folder = join(paths.plugins, 'ui-example'); mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), 'export default function() {}');
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ title: 'UI example', configSchema: { type: 'object', properties: { label: { type: 'string', title: 'Button label', default: 'Plugin entry' } } } }));
  writeFileSync(join(folder, 'web.js'), `export default function(api) {
    for (const slot of ['sidebar','composer','settings','inspector']) {
      const node = document.createElement(slot === 'settings' ? 'section' : 'button');
      if (node.tagName === 'BUTTON') node.type = 'button';
      node.dataset.exampleSlot = slot; node.textContent = slot === 'sidebar' ? api.config.label : 'Plugin ' + slot;
      if (slot === 'composer') node.onclick = () => api.insert('Inserted by plugin');
      if (slot === 'inspector') node.onclick = () => {const p = document.createElement('p');p.textContent='Plugin preview';api.inspect('Example',p);};
      api.mount(slot,node);
    }
    const settingsPage = document.createElement('p'); settingsPage.textContent = 'Plugin preferences';
    api.settingsPage('Example settings', settingsPage);
    api.command({ name: 'example', description: 'Add a plugin note', run: () => api.insert('Plugin note') });
    api.tool('ls', () => { const node = document.createElement('p'); node.textContent = 'Custom listing result'; return node; });
  }`);
  const dependent = join(paths.plugins, 'a-dependent'); mkdirSync(dependent);
  writeFileSync(join(dependent, 'plugin.js'), 'export default function() {}');
  writeFileSync(join(dependent, 'plugin.json'), JSON.stringify({ title: 'Dependent UI', requires: ['ui-example'] }));
  writeFileSync(join(dependent, 'web.js'), `export default function(api) {
    const parent = document.querySelector('[data-example-slot=sidebar]');
    if (!parent) throw new Error('Dependency must mount first');
    const node = document.createElement('button'); node.type = 'button'; node.textContent = 'Dependent ' + parent.textContent; api.mount('sidebar', node);
    api.onDispose(() => { document.documentElement.dataset.dependencyDisposal = parent.isConnected ? 'ordered' : 'incorrect'; });
  }`);
  const settings = readJson<any>(paths.settings, {}); writeJson(paths.settings, { ...settings, plugins: { 'ui-example': true, 'a-dependent': true } });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await expect(page.getByRole('button', { name: 'Plugin entry', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dependent Plugin entry', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Plugin composer', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Inserted by plugin');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Custom listing result')).toBeHidden();
    await expect(page.locator('.message.assistant')).toHaveText('Done');
    await page.locator('.tool-card summary').click(); await expect(page.getByText('Custom listing result')).toBeVisible();
    await page.getByRole('button', { name: 'Open inspector', exact: true }).click();
    await page.getByRole('button', { name: 'Plugin inspector', exact: true }).click();
    await expect(page.getByText('Plugin preview', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'Example settings').click();
    await expect(page.getByText('Plugin preferences')).toBeVisible();
    await settingsSection(page, 'Extensions').click();
    await expect(page.getByText('Plugin settings', { exact: true })).toBeVisible();
    await settingsSection(page, 'Plugins').click();
    await page.getByRole('button', { name: 'Manage plugins', exact: true }).click();
    await page.getByRole('button', { name: 'UI example settings', exact: true }).click();
    await page.getByLabel('Button label · ui-example', { exact: true }).fill('Updated plugin');
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await expect(page.locator('[data-example-slot=sidebar]')).toHaveCount(1);
    await expect(page.locator('[data-example-slot=sidebar]')).toHaveText('Updated plugin');
    await expect(page.getByRole('button', { name: 'Dependent Updated plugin', exact: true })).toBeAttached();
    await page.getByRole('button', { name: 'All plugins', exact: true }).click();
    await page.getByRole('switch', { name: 'Dependent UI', exact: true }).uncheck();
    await expect(page.getByRole('button', { name: 'Dependent Updated plugin', exact: true })).toHaveCount(0);
    await page.getByRole('switch', { name: 'UI example', exact: true }).uncheck();
    await expect(page.locator('[data-example-slot]')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-dependency-disposal', 'ordered');
    await expect(page.getByText('Plugin preview', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(settingsSection(page, 'Example settings')).toHaveCount(0);
    await expect(settingsSection(page, 'Extensions')).toBeHidden();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: 'Inserted by plugin', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/ex');
    await expect(suggestions(page).getByRole('option', { name: /Add a plugin note/ })).toHaveCount(0);
    await page.locator('.tool-card summary').click();
    await expect(page.getByText('Custom listing result')).toHaveCount(0);
    await expect(page.locator('.tool-content pre').first()).toBeVisible();
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('file inspection, responsive themes and reduced viewport height keep controls reachable', async ({ browser }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const note = join(paths.cwd, 'notes.md');
  writeFileSync(note, '# Visible file\nBefore edits');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: paths.cwd });
  git('init', '--quiet');
  git('add', 'notes.md');
  writeFileSync(note, '# Visible file\nWorkspace content');
  const service = await startIsolatedHost(paths);
  try {
    for (const width of [1366, 768, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      try {
        await page.goto(service.url + '/#token=' + service.token);
        if (width <= 860) await page.getByRole('button', { name: 'Toggle navigation' }).click();
        await page.getByRole('button', { name: 'Workspace files', exact: true }).click();
        await expect(page.getByText('Git changes', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'AM notes.md', exact: true }).click();
        await expect(page.locator('.diff .added')).toHaveText(['+# Visible file', '+Before edits', '+Workspace content']);
        await page.getByRole('button', { name: 'Preview', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeFocused();
        await expect(page.locator('.file-preview')).toHaveText('# Visible file\nWorkspace content');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.getByRole('button', { name: 'Close inspector' }).click();
        if (width <= 860) await page.getByRole('button', { name: 'Close navigation' }).first().click();
        for (const theme of ['dark', 'light']) {
          if (width <= 860) await page.getByRole('button', { name: 'Toggle navigation' }).click();
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
          await settingsSection(page, 'Appearance').click();
          await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await page.getByRole('button', { name: 'Close settings' }).click();
        }
        await page.setViewportSize({ width, height: 380 });
        await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A long task '.repeat(100));
        const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
        expect(send.y + send.height).toBeLessThanOrEqual(380);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally { await page.close(); }
    }
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('custom provider onboarding and switching workspace work entirely in the GUI', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const second = join(root, 'another-workspace'); mkdirSync(second);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toHaveCount(0);
    await settings.getByRole('button', { name: 'Add provider' }).click();
    await expect(settings.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
    await settings.getByRole('radio', { name: 'Custom API' }).check();
    await settings.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('gui-added');
    await settings.getByRole('textbox', { name: 'API endpoint', exact: true }).fill(mock.url);
    await settings.getByRole('textbox', { name: 'Model ID', exact: true }).fill('new-model');
    await settings.getByRole('textbox', { name: 'Display name', exact: true }).fill('GUI Model');
    await settings.getByLabel('API key', { exact: true }).fill('test-only-key');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Provider saved.', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Edit gui-added', exact: true }).click();
    await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('');
    await settings.getByRole('textbox', { name: 'Display name', exact: true }).fill('GUI Model edited');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Provider saved.', { exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Edit gui-added', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await chooseModel(page, 'GUI Model edited');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Configured from GUI');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    expect(mock.requests.at(-1).model).toBe('new-model');
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
    await page.getByRole('textbox', { name: 'Absolute directory path', exact: true }).fill(second);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.locator('#workspaceLabel')).toHaveText(second);
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
    await page.getByRole('textbox', { name: 'Absolute directory path', exact: true }).fill(paths.cwd);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.locator('#workspaceLabel')).toHaveText(paths.cwd);
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('running messages can queue follow-ups and approve shell commands from the GUI', async ({ page }) => {
  let release: () => void, entered: () => void;
  const held = new Promise<void>((done) => { release = done; }), waiting = new Promise<void>((done) => { entered = done; });
  const mock = await createMockProvider(async ({ messages }) => {
    if (messages.at(-1).content === 'Wait') { entered(); await held; return 'First reply'; }
    if (messages.at(-1).content === 'Shell task') return { tool: 'sandbox_shell', args: { command: 'echo approved' } };
    return 'Finished';
  });
  const { root, paths } = createFixturePaths(mock.url);
  writeJson(paths.settings, { ...readJson<any>(paths.settings, {}), plugins: { shell: true }, sandbox: { mode: 'host' } });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Wait');
    await page.getByRole('button', { name: 'Send', exact: true }).click(); await waiting;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue');
    await page.getByRole('combobox', { name: 'While running', exact: true }).selectOption('followUp');
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(page.locator('#queuedMessages')).toHaveText('Follow up: Continue');
    release();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.locator('#queuedMessages')).toBeHidden();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Shell task');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.approval-card pre')).toHaveText('echo approved');
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.locator('.approval-card')).toHaveCount(0);
    await page.locator('.tool-card summary').click();
    await expect(page.locator('.tool-arguments')).toContainText('echo approved');
    await expect(page.locator('.tool-content')).toContainText('Exit 0');
    await expect(page.locator('.tool-duration')).toHaveText(/\d+ (ms|s)/);
    await expect(page.locator('#runSummary')).toContainText('Completed');
  } finally { release(); await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('retry retains image attachments after selecting an image-capable model', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const models = readJson<any>(join(paths.home, 'models.json'), {});
  models.providers['local-mock'].models.push({ ...models.providers['local-mock'].models[0], id: 'vision-model', input: ['text', 'image'] });
  writeJson(join(paths.home, 'models.json'), models);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.locator('#composer input[type=file]').setInputFiles(resolve('web/icon-192.png'));
    await expect(page.locator('.attachment')).toHaveCount(1);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read the picture');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.error')).toContainText('does not support image input');
    await chooseModel(page, 'vision-model');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    expect(JSON.stringify(mock.requests.at(-1))).toContain('image_url');
    await expect(page.locator('.message-image')).toHaveCount(1);
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});


test('plugin catalog applies configuration and removes disabled browser capabilities', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'Browse plugins' }).click();
    const catalog = page.getByRole('region', { name: 'Plugin catalog' });
    await expect(catalog.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
    const files = catalog.getByRole('switch', { name: 'Workspace files', exact: true });
    await expect(files).toBeChecked();
    await files.uncheck();
    await expect(files).not.toBeChecked();
    await expect(page.locator('#sidebarExtensions').getByRole('button', { name: 'Workspace files', includeHidden: true })).toHaveCount(0);
    await files.check();
    await expect(page.locator('#sidebarExtensions').getByRole('button', { name: 'Workspace files', includeHidden: true })).toHaveCount(1);
    await catalog.getByRole('button', { name: 'Install plugin', exact: true }).click();
    const install = page.getByRole('dialog', { name: 'Install plugin' });
    await install.getByLabel('Plugin ID', { exact: true }).fill('local-example');
    await expect(install.getByRole('button', { name: 'Install plugin', exact: true })).toBeDisabled();
    await install.getByLabel('Plugin bundle files').setInputFiles({
      name: 'plugin.js', mimeType: 'text/javascript', buffer: Buffer.from('export default function setup() {}')
    });
    await expect(install.getByRole('list', { name: 'Selected files' })).toHaveText('plugin.js');
    await install.getByRole('button', { name: 'Install plugin', exact: true }).click();
    await expect(install).toBeHidden();
    await expect(catalog.getByRole('switch', { name: 'local-example', exact: true })).not.toBeChecked();
    await catalog.getByRole('button', { name: 'Subagents settings' }).click();
    await catalog.getByRole('spinbutton', { name: 'Maximum child depth · subagents' }).fill('2');
    await catalog.getByRole('button', { name: 'Save configuration' }).click();
    await expect(catalog.getByText('Saved.', { exact: true })).toBeVisible();
    await catalog.getByRole('button', { name: /All plugins/ }).click();
    await catalog.getByRole('button', { name: 'Subagents settings' }).click();
    await expect(catalog.getByRole('spinbutton', { name: 'Maximum child depth · subagents' })).toHaveValue('2');
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
