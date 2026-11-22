import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { readJson, writeJson } from '../../src/config.js';
import { startIsolatedHost, settingsSection, modelButton, modelSearch, suggestions, chooseModel } from './fixtures.js';

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
        await expect(settingsSection(page, 'Plugins')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Manage plugins', exact: true })).toHaveCount(0);
        await settingsSection(page, 'Appearance').click();
        await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Install plugin', exact: true })).toBeHidden();
        await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const dialog = await page.locator('#settingsPanel').boundingBox();
        expect(dialog.x).toBeGreaterThanOrEqual(0);
        expect(dialog.x + dialog.width).toBeLessThanOrEqual(viewport.width);
        if (viewport.width > 560) {
          expect(Math.abs(dialog.x - (viewport.width - dialog.width) / 2)).toBeLessThan(2);
          await page.getByRole('heading', { name: 'Appearance', exact: true }).click();
          await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
          await page.mouse.click(4, 4);
          await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
        } else {
          await expect(settingsSection(page, 'Appearance')).toBeHidden();
          await page.getByRole('button', { name: /All settings/ }).click();
          await expect(settingsSection(page, 'Appearance')).toBeFocused();
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
      await page.reload({ waitUntil: 'domcontentloaded' });
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
      const first = page.getByRole('button', { name: 'Keep working', exact: true });
      const id = (await first.getAttribute('id')).slice('session-'.length);
      let resume: () => void, intercept: () => void;
      const reached = new Promise<void>((done) => { intercept = done; });
      const delayed = new Promise<void>((done) => { resume = done; });
      await page.route('**/api/sessions/' + id, async (route) => {
        intercept();
        await delayed;
        await route.continue().catch(() => { /* A later selection aborts this request. */ });
      }, { times: 1 });
      try {
        await first.click();
        await reached;
        await page.getByRole('button', { name: 'Second conversation', exact: true }).click();
        await expect(page.locator('.message.assistant')).toHaveText('Independent reply');
      } finally { resume(); }
      await openSidebar();
      let disconnected = false;
      await page.route(/\/events\?run=/, (route) => {
        disconnected = true;
        return route.abort();
      }, { times: 1 });
      await first.click();
      await expect.poll(() => disconnected).toBe(true);
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
    await expect(page.locator('.tool-exit-code')).toHaveText('Exit 0');
    await expect(page.locator('#runSummary')).toContainText('Completed');
    await page.reload();
    await expect(page.locator('.tool-exit-code')).toHaveText('Exit 0');
    await expect(page.locator('.tool-duration')).toHaveText(/\d+ (ms|s)/);
  } finally { release(); await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('message actions use icons and allow copying or editing the text', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    const prompt = page.getByRole('textbox', { name: 'Message', exact: true });
    await prompt.fill('Edit me');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message-row.assistant .message')).toHaveText('Mock response');
    await expect(page.locator('.message-row.user .message-action')).toHaveCount(2);
    await expect(page.locator('.message-row.assistant .message-action')).toHaveCount(1);
    await expect(page.locator('.message-time')).toHaveCount(2);

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: {
          writeText: async (text: string) => { (window as Window & { copiedMessage?: string }).copiedMessage = text; }
        }
      });
    });
    await page.locator('.message-row.assistant').getByRole('button', { name: 'Copy message' }).click();
    await expect(page.locator('.message-row.assistant').getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { copiedMessage?: string }).copiedMessage)).toBe('Mock response');

    await page.locator('.message-row.user').getByRole('button', { name: 'Edit message' }).click();
    await expect(prompt).toHaveValue('Edit me');
    await expect(prompt).toBeFocused();
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
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
