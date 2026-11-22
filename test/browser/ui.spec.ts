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
  // Isolate the application, while Playwright keeps the installed browser cache.
  const userHome = resolve(paths.home, '..', 'user');
  mkdirSync(userHome, { recursive: true });
  const port = await availablePort();
  const child: ChildProcess = spawn(process.execPath, [
    resolve('dist/bin/mini-harness.js'), '--no-open', '--cwd', paths.cwd, '--port', String(port)
  ], {
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome, XDG_CONFIG_HOME: join(userHome, '.config'), MINI_HARNESS_HOME: paths.home },
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

async function expandProcess(page: Page) {
  for (const group of await page.locator('.process-group').all()) {
    if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  }
}

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

test('settings layout stays consistent across viewport sizes and themes', async ({ browser }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      try {
        await page.goto(service.url + '/#token=' + service.token);
        await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
        await page.locator('#workspaceLabel').evaluate((label) => { label.textContent = 'workspace'; });
        if (viewport.width <= 860) await page.getByRole('button', { name: 'Toggle navigation' }).click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await settingsSection(page, 'Model').click();
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          if (process.platform !== 'win32') await expect(page).toHaveScreenshot('settings-' + viewport.width + '-' + colorScheme + '.png', {
            animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02
          });
        }
      } finally { await page.close(); }
    }
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
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
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n?/g, '\n')).toContain('```text\nExample\n```');
    await expect(page.locator('.message img, .message .overlay')).toHaveCount(0);
    await expect(page.getByText('A tool note')).toBeVisible();
    await expect(page.locator('.tool-card summary')).toContainText('Search');
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

test('session model choices and thinking levels survive navigation and page reload', async ({ page }) => {
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
    await expect(modelButton(page)).toHaveText('Mock Model');
    await page.reload();
    await expect(modelButton(page)).toHaveText('Mock Model');
    await page.getByRole('textbox', { name: 'Message' }).fill('Use the recent model');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    expect(mock.requests.at(-1).model).toBe('mock-model');
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
    await page.getByRole('searchbox', { name: 'Search workspaces and conversations' }).fill('absent');
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search workspaces and conversations' }).fill('review');
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
    await expandProcess(page);
    await page.locator('.tool-card summary').click(); await expect(page.getByText('Custom listing result')).toBeVisible();
    await page.getByRole('button', { name: 'Open workspace panel', exact: true }).click();
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
    await expandProcess(page);
    await page.locator('.tool-card summary').click();
    await expect(page.getByText('Custom listing result')).toHaveCount(0);
    await expect(page.locator('.tool-content pre').first()).toBeVisible();
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('file inspection, responsive themes and reduced viewport height keep controls reachable', async ({ browser }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const note = join(paths.cwd, 'notes.md');
  writeFileSync(note, '# Visible file\nBefore edits');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: paths.cwd, env: { ...process.env, HOME: resolve(paths.home, '..', 'user'), USERPROFILE: resolve(paths.home, '..', 'user') } });
  git('init', '--quiet');
  git('add', 'notes.md');
  writeFileSync(note, '# Visible file\nWorkspace content');
  const service = await startIsolatedHost(paths);
  try {
    for (const width of [1366, 768, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      try {
        await page.goto(service.url + '/#token=' + service.token);
        if (width <= 860) {
          const navigation = page.getByRole('button', { name: 'Toggle navigation' });
          const close = page.getByRole('dialog', { name: 'Conversations' }).getByRole('button', { name: 'Close navigation' });
          await navigation.click();
          await expect(close).toBeFocused();
          await close.press('Shift+Tab');
          await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(navigation).toBeFocused();
          await navigation.click();
        }
        await page.getByRole('button', { name: 'Workspace files', exact: true }).click();
        const panel = page.locator('#inspector');
        await expect(panel.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'notes.md AM', exact: true })).toBeVisible();
        await panel.getByRole('button', { name: 'Git changes', exact: true }).click();
        await panel.getByRole('button', { name: 'notes.md AM', exact: true }).click();
        await expect(panel.locator('.diff .added')).toHaveText(['+# Visible file', '+Before edits', '+Workspace content']);
        await panel.getByRole('button', { name: 'Preview', exact: true }).click();
        await expect(panel.getByRole('tab', { name: 'notes.md', exact: true })).toBeFocused();
        await expect(panel.getByRole('heading', { name: 'Visible file' })).toBeVisible();
        await panel.getByRole('button', { name: 'Source', exact: true }).click();
        await expect(panel.locator('.file-preview')).toHaveText(/# Visible file\r?\nWorkspace content/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await panel.getByRole('tab', { name: 'notes.md', exact: true }).focus();
        await page.locator('#workspaceLabel').evaluate((label) => { label.textContent = 'workspace'; });
        await page.locator('html').evaluate((html) => { html.dataset.theme = 'system'; });
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
          if (process.platform !== 'win32') await expect(page).toHaveScreenshot('workspace-panel-' + width + '-' + colorScheme + '.png', {
            animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02
          });
        }
        await panel.getByRole('button', { name: 'Close workspace panel' }).click();
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

test('custom provider onboarding and registering a workspace work entirely in the GUI', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add workspace' });
    await expect(picker.getByLabel('Absolute directory path')).toHaveValue(paths.cwd);
    await picker.getByRole('button', { name: 'Up', exact: true }).click();
    await picker.getByRole('button', { name: 'another-workspace', exact: true }).click();
    await expect(picker.getByLabel('Absolute directory path')).toHaveValue(second);
    await picker.getByRole('button', { name: 'Add workspace', exact: true }).click();
    await expect(page.locator('#workspaceLabel')).toHaveText(second);
    await expect(page.locator('#sessions .session-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Configured from GUI', exact: true }).click();
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
  writeJson(paths.settings, { ...readJson<any>(paths.settings, {}), plugins: { shell: true }, sandbox: { mode: 'host' }, defaultPermission: 'full' });
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
    await expandProcess(page);
    await page.locator('.tool-card summary').click();
    await expect(page.locator('.tool-arguments')).toContainText('echo approved');
    await expect(page.locator('.tool-content')).toContainText('Exit 0');
    await expect(page.locator('.tool-card summary')).not.toContainText(/\d+ (ms|s)/);
    await page.getByRole('button', { name: 'Inspect', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Trajectory', exact: true })).toContainText(/Elapsed[\s\S]*\d+ ms/);
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
    await expect(files).toBeEnabled();
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'workspace', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'Browse plugins' }).click();
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

test('switching workspaces preserves running conversations and each conversation’s file tabs', async ({ page }) => {
  let entered: () => void, release: () => void;
  const waiting = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  const mock = await createMockProvider(async ({ messages }) => {
    if (messages.at(-1).content === 'Keep working here') { entered(); await held; return 'First workspace finished'; }
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
    const handle = await separator.boundingBox();
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

test('switch transitions respect reduced motion and roll back a failed setting once', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    let requests = 0, release: () => void;
    const held = new Promise<void>((done) => { release = done; });
    await page.route('**/api/settings', async (route) => {
      requests++;
      await held;
      await route.fulfill({ status: 400, json: { error: 'The switch could not be saved' } });
    });
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Browse plugins' }).click();
    const files = page.getByRole('switch', { name: 'Workspace files', exact: true });
    const duration = () => files.evaluate((node) => getComputedStyle(node, '::after').transitionDuration);
    expect(await duration()).toBe('0.16s, 0.16s');
    await files.uncheck();
    await expect(files).toHaveAttribute('aria-busy', 'true');
    await expect(files).toBeDisabled();
    await files.evaluate((node: HTMLInputElement) => node.click());
    release();
    await expect(page.getByRole('status').filter({ hasText: 'The switch could not be saved' })).toBeVisible();
    await expect(files).toBeChecked();
    await expect(files).toBeEnabled();
    expect(requests).toBe(1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect((await duration()).split(',').every((value) => parseFloat(value) === 0)).toBe(true);
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('tasks, trajectory, resource links and session tabs share persistent Pi facts', async ({ page }) => {
  let step = 0;
  const mock = await createMockProvider(() => {
    if (++step === 1) return { tool: 'update_todos', args: { items: [{ id: 'verify', text: 'Verify the file', state: 'in-progress' }] } };
    if (step === 2) return { tool: 'read', args: { path: 'note.txt' } };
    return 'Verified. [Open the file](note.txt#L2)';
  });
  const { root, paths } = createFixturePaths(mock.url);
  writeFileSync(join(paths.cwd, 'note.txt'), 'First line\nSecond line\n');
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Verify resources');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant').last()).toContainText('Verified.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Conversation tasks' })).toContainText('Verify the file');
    expect(await page.locator('.todo-dock').evaluate((node) => node.getBoundingClientRect().bottom <= document.getElementById('composer').getBoundingClientRect().top)).toBe(true);
    await expect(page.locator('.process-group')).not.toHaveAttribute('open', '');
    await page.getByRole('link', { name: 'Open the file' }).click();
    const panel = page.getByRole('complementary', { name: 'Workspace panel', exact: true });
    await expect(panel.locator('.highlighted-line')).toHaveAttribute('data-line', '2');
    await panel.getByRole('button', { name: 'Close workspace panel' }).click();
    await expandProcess(page);
    await page.locator('.tool-card summary').filter({ hasText: 'Read file' }).click();
    await page.locator('.tool-card').filter({ hasText: 'Read file' }).getByRole('button', { name: 'Inspect', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Trajectory' })).toContainText('Step');
    await expect(page.getByRole('region', { name: 'Trajectory' })).toContainText('Unavailable');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: /New conversation/ }).click();
    await expect(page.getByRole('region', { name: 'Conversation tasks' })).toBeHidden();
    await page.getByRole('button', { name: 'Verify resources', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Conversation tasks' })).toContainText('Verify the file');
    await page.getByRole('button', { name: 'Open workspace panel', exact: true }).click();
    await expect(panel.getByRole('tab', { name: 'note.txt', exact: true })).toHaveCount(1);
    await expect(panel.locator('.file-preview')).toContainText('Second line');
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('contribution overrides restore tool cards and dock positions without duplicate nodes', async ({ page }) => {
  const mock = await createMockProvider(({ messages }) => messages.at(-1).role === 'tool' ? 'Done' : { tool: 'read', args: { path: 'note.txt' } });
  const { root, paths } = createFixturePaths(mock.url);
  writeFileSync(join(paths.cwd, 'note.txt'), 'File content');
  for (const [id, priority, label] of [['base-view', 0, 'Base'], ['override-view', 10, 'Override']] as const) {
    const folder = join(paths.plugins, id); mkdirSync(folder);
    writeFileSync(join(folder, 'plugin.js'), 'export default () => {}');
    writeJson(join(folder, 'plugin.json'), { title: label + ' view' });
    writeFileSync(join(folder, 'web.js'), `export default (api) => {
      const dock = document.createElement('span'); dock.textContent = '${label} usage'; dock.dataset.testDock = '${id}';
      api.contribute('conversation.composer.dock', {id: 'usage', priority: ${priority}, value: dock});
      api.contribute('plugins.detail.section', {id: 'details', priority: ${priority}, value: (plugin) => {
        const node = document.createElement('p'); node.textContent = '${label} details for ' + plugin.title; return node;
      }});
      api.contribute('tool.call.toolview', {id: 'read', key: 'read', priority: ${priority}, value: () => {
        const node = document.createElement('p'); node.textContent = '${label} reader'; return node;
      }});
    };`);
  }
  writeJson(paths.settings, { ...readJson<any>(paths.settings, {}), plugins: { 'base-view': true, 'override-view': true } });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await expect(page.getByText('Override usage', { exact: true })).toBeVisible();
    await expect(page.getByText('Base usage', { exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read with a view');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Done');
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    await expandProcess(page); await page.locator('.tool-card summary').click();
    await expect(page.getByText('Override reader', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Browse plugins' }).click();
    await page.getByRole('button', { name: 'Base view settings', exact: true }).click();
    await expect(page.getByText('Override details for Base view', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All plugins', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Override view', exact: true });
    for (let index = 0; index < 3; index++) {
      await toggle.uncheck(); await expect(toggle).toBeEnabled();
      await expect(page.locator('[data-test-dock="base-view"]')).toHaveCount(1);
      await expect(page.locator('[data-test-dock="override-view"]')).toHaveCount(0);
      await toggle.check(); await expect(toggle).toBeEnabled();
    }
    await toggle.uncheck(); await expect(toggle).toBeEnabled();
    await page.getByRole('button', { name: 'Base view settings', exact: true }).click();
    await expect(page.getByText('Base details for Base view', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All plugins', exact: true }).click();
    await page.getByRole('button', { name: 'Read with a view', exact: true }).click();
    await expandProcess(page); await page.locator('.tool-card summary').click();
    await expect(page.getByText('Base reader', { exact: true })).toBeVisible();
    await expect(page.getByText('Override reader', { exact: true })).toHaveCount(0);
    await expect(page.locator('.composer-dock > *')).toHaveCount(2);
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('independent font sizes, 200 percent layout and mobile keyboard height keep composer controls usable', async ({ browser }) => {
  const mock = await createMockProvider(() => 'Done\n\n```ts\nconst x = 1\n```');
  const { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'Appearance').click();
    await page.getByLabel('Body text size', { exact: true }).fill('22');
    await page.getByLabel('Body text size', { exact: true }).press('Tab');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('22px');
    await page.getByLabel('Code size', { exact: true }).fill('19');
    await page.getByLabel('Code size', { exact: true }).press('Tab');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-code'))).toBe('19px');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.setViewportSize({ width: 390, height: 370 });
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check font sizes');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeInViewport(); await send.click();
    await expect(page.locator('.message.assistant')).toContainText('Done');
    await expect.poll(() => page.locator('.code-block code').evaluate((node) => getComputedStyle(node).fontSize)).toBe('19px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await expect(send).toBeInViewport();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Zoomed input');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('permission changes require confirmation and future defaults leave the current session alone', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    const permission = page.getByRole('combobox', { name: 'Execution permission', exact: true });
    await expect(permission).toHaveValue('workspace-write');
    await permission.selectOption('read-only');
    await expect(permission).toBeEnabled();
    await expect(permission).toHaveValue('read-only');
    page.once('dialog', (dialog) => dialog.dismiss());
    await permission.selectOption('full');
    await expect(permission).toHaveValue('read-only');
    page.once('dialog', (dialog) => dialog.accept());
    await permission.selectOption('full');
    await expect(permission).toBeEnabled();
    await expect(permission).toHaveValue('full');
    const sessions = await (await page.request.get(service.url + '/api/sessions', { headers: { Authorization: 'Bearer ' + service.token } })).json();
    expect(sessions).toHaveLength(1); expect(sessions[0].permission).toBe('full');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'Execution').click();
    const defaults = page.getByRole('combobox', { name: 'Default execution permission', exact: true });
    await defaults.selectOption('read-only');
    await expect(defaults).toBeEnabled();
    await expect(defaults).toHaveValue('read-only');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(permission).toHaveValue('full');
    await page.locator('#newSession').click();
    await expect(permission).toHaveValue('read-only');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read-only draft');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    const updated = await (await page.request.get(service.url + '/api/sessions', { headers: { Authorization: 'Bearer ' + service.token } })).json();
    expect(updated.find((item) => item.title === 'Read-only draft').permission).toBe('read-only');
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('shared tab definitions keep independent identities and release inactive and closed resources', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const folder = join(paths.plugins, 'resources'); mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), 'export default () => {}');
  writeFileSync(join(folder, 'web.js'), `export default (api) => {
    let disposed = 0;
    const status = document.createElement('p'); status.textContent = 'Resources released: 0'; api.mount('sidebar', status);
    const definition = {
      title: (address) => address.type.endsWith('one') ? 'Resource one' : 'Resource two', keepMounted: false,
      create(address, signal) {
        const node = document.createElement('p'); node.textContent = 'Content ' + address.type;
        signal.addEventListener('abort', () => { status.textContent = 'Resources released: ' + (++disposed); }, {once:true});
        return node;
      }
    };
    for (const type of ['one','two']) {
      api.rightTab(type, definition);
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Open resource ' + type;
      button.onclick = () => api.openTab(type); api.mount('sidebar', button);
    }
  };`);
  writeJson(paths.settings, { ...readJson<any>(paths.settings, {}), plugins: { resources: true } });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Open resource one', exact: true }).click();
    await expect(page.getByText('Content resources:one', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open resource two', exact: true }).click();
    await expect(page.getByText('Content resources:two', { exact: true })).toBeVisible();
    await expect(page.getByText('Resources released: 1', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Resource one', exact: true }).click();
    await expect(page.getByText('Content resources:one', { exact: true })).toBeVisible();
    await expect(page.getByText('Resources released: 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close tab Resource one', exact: true }).click();
    await expect(page.getByText('Resources released: 3', { exact: true })).toBeVisible();
    await expect(page.getByText('Content resources:two', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close tab Resource two', exact: true }).click();
    await expect(page.getByText('Resources released: 4', { exact: true })).toBeVisible();
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('remembered theme runs as a classic script before bootstrap finishes without startup errors', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  let release: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.addInitScript(() => localStorage.setItem('mini-harness-theme', 'dark'));
    await page.route('**/api/bootstrap', async (route) => { await held; await route.continue(); });
    await page.goto(service.url + '/#token=' + service.token);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    release();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { release(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
