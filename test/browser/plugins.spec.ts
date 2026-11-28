import { expect } from '@playwright/test';
import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJson } from '@mini-harness/platform/json';
import { browserTest as test, settingsSection, modelButton, modelSearch } from '../support/browser.ts';

test('plugin settings keep their identity when renamed and disappear on disable', async ({
  page,
  launch,
}) => {
  const { host } = await launch({
    prepare(paths) {
      const folder = join(paths.plugins, 'ui-example');
      mkdirSync(folder);
      writeJson(join(folder, 'plugin.json'), { title: 'UI example' });
      writeFileSync(
        join(folder, 'web.js'),
        `
export const inject = ['miniPrimitives', 'miniSlots', 'miniSettings', 'miniSettingsRegistry'];
import { browserPluginSettings } from 'mini-harness/ui-runtime/plugin-settings';
export function apply(ctx) {
  const { miniPrimitives: ui, miniSettingsRegistry: registry } = ctx;
  const update = registry.registerSection({ id: 'example', title: 'Example settings' }, ctx.fiber.signal);
  const start = ui.button('Open example settings');
  start.onclick = () => ctx.miniSettings.open('example');
  ctx.effect(() => ctx.miniSlots.register('sidebar.actions', start));
  ctx.effect(() => registry.register('ui-example', {
    id: 'preferences',
    sectionId: 'example',
    render() {
      const name = document.createElement('input');
      const rename = ui.button('Translate section');
      rename.onclick = () => update({ title: 'Translated settings' });
      const content = document.createElement('div');
      content.append(ui.field('Display name', name), rename);
      return content;
    },
  }, browserPluginSettings(ctx)));
}
`,
      );
      writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
        plugins: [{ id: 'ui-example', name: '../../plugins/ui-example', client: true }],
      });
    },
  });
  await page.goto(host.url + '/#token=' + host.token);
  const entry = page.getByRole('button', { name: 'Open example settings' });
  await entry.click();
  const input = page.getByRole('textbox', { name: 'Display name' });
  await input.fill('Keep this draft');
  await page.getByRole('button', { name: 'Translate section' }).click();
  await expect(settingsSection(page, 'Translated settings')).toHaveAttribute('aria-current', 'page');
  await expect(input).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Browse plugins' }).click();
  await page.getByRole('switch', { name: 'UI example', exact: true }).uncheck();
  await expect(entry).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settingsSection(page, 'Translated settings')).toHaveCount(0);
});

test('a failed browser plugin reports the saved state and can be retried', async ({ page, launch }) => {
  const { host } = await launch({
    prepare(paths) {
      const folder = join(paths.plugins, 'retry-ui');
      mkdirSync(folder);
      writeFileSync(
        join(folder, 'plugin.js'),
        "import { defineConfig } from 'mini-harness/configuration';\nimport { readFileSync } from 'node:fs';\nexport const Config = defineConfig(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')));",
      );
      writeFileSync(
        join(folder, 'schema.json'),
        JSON.stringify({
          type: 'object',
          properties: { ready: { type: 'boolean', title: 'Ready', default: false } },
        }),
      );
      writeJson(join(folder, 'plugin.json'), {
        title: 'Retry UI',
        browserDirectory: 'web',
      });
      mkdirSync(join(folder, 'web'));
      writeFileSync(
        join(folder, 'web.js'),
        `
    export const inject = ["miniSlots"];
export const provide = ["retryFixture"];

    export const apply = (ctx, config) => {
        ctx.effect(() => {
          document.body.dataset.retryEffect = 'mounted';
          return () => { document.body.dataset.retryEffect = 'released'; };
        });
        const node = document.createElement('button');
        node.textContent = 'Recovered UI';
        ctx.effect(() => ctx.miniSlots.register('conversation.composer', node));
        if (!config.ready) throw new Error('Not ready');
    ctx.provide('retryFixture', node);
      };
    `,
      );
      const dependent = join(paths.plugins, 'retry-dependent');
      mkdirSync(dependent);
      writeJson(join(dependent, 'plugin.json'), { title: 'Retry dependent' });
      writeFileSync(
        join(dependent, 'web.js'),
        `
export const inject = ['miniSlots', 'miniPrimitives', 'retryFixture'];
export function apply(ctx) {
  const source = ctx.retryFixture;
  ctx.effect(() => ctx.miniSlots.register('sidebar.actions',
    ctx.miniPrimitives.button('Depends on ' + source.textContent)));
  ctx.effect(() => () => {
    document.body.dataset.retryDependent = source.isConnected ? 'released first' : 'released late';
  });
}
`,
      );
      writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
        plugins: [
          { id: 'retry-ui', name: '../../plugins/retry-ui', disabled: true },
          { id: 'retry-dependent', name: '../../plugins/retry-dependent', client: true },
        ],
      });
    },
  });
  await page.goto(host.url + '/#token=' + host.token);
  await page.getByRole('button', { name: 'Browse plugins' }).click();
  const control = page.getByRole('switch', { name: 'Retry UI' });
  await control.check();
  await expect(page.getByText('Saved on the server. Browser plugins failed: retry-ui')).toBeVisible();
  await expect(control).toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Recovered UI', exact: true, includeHidden: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Browser setup failed.*Not ready/)).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-retry-effect', 'released');
  const retry = await fetch(host.url + '/api/settings', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + host.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: { 'retry-ui': { config: { ready: true } } } }),
  });
  expect(retry.status, await retry.text()).toBe(200);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByRole('button', { name: 'Recovered UI', exact: true })).toHaveCount(1);
  await expect(page.locator('body')).toHaveAttribute('data-retry-effect', 'mounted');
  const dependent = page.getByRole('button', { name: 'Depends on Recovered UI' });
  await expect(dependent).toBeVisible();
  await page.getByRole('button', { name: 'Browse plugins' }).click();
  await control.uncheck();
  await expect(dependent).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-retry-dependent', 'released first');
});

test('plugin catalog applies configuration and removes disabled browser capabilities', async ({
  page,
  launch,
}) => {
  const { host } = await launch();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(host.url + '/#token=' + host.token);
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Browse plugins' }).click();
  const catalog = page.getByRole('region', { name: 'Plugin catalog' });
  await expect(catalog.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
  await expect(catalog.getByRole('button', { name: 'Workspace files settings' })).toHaveCount(0);
  await expect(catalog.getByRole('switch', { name: 'Subagents', exact: true })).toHaveCount(0);
  const openBuiltins = async () => {
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'Built-in plugins').click();
  };
  const closeSettings = () => page.getByRole('button', { name: 'Close settings' }).click();
  await openBuiltins();
  const files = page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('switch', { name: 'Workspace files', exact: true });
  await expect(files).toBeChecked();
  await files.uncheck();
  await expect(files).not.toBeChecked();
  await expect(
    page.locator('#sidebarExtensions').getByRole('button', { name: 'Workspace files', includeHidden: true }),
  ).toHaveCount(0);
  await expect(files).toBeEnabled();
  await closeSettings();
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'workspace', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await openBuiltins();
  await files.check();
  await expect(files).toBeChecked();
  await expect(files).toBeEnabled();
  let requests = 0,
    release: () => void = () => {
      throw new Error('Not started');
    };
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    requests++;
    await held;
    await route.fulfill({ status: 400, json: { error: 'The switch could not be saved' } });
  });
  try {
    await files.uncheck();
    await expect(files).toHaveAttribute('aria-busy', 'true');
    await expect(files).toBeDisabled();
    await files.evaluate((node: HTMLInputElement) => node.click());
    release();
    await expect(page.getByRole('status').filter({ hasText: 'The switch could not be saved' })).toBeVisible();
    await expect(files).toBeChecked();
    await expect(files).toBeEnabled();
    expect(requests).toBe(1);
  } finally {
    release();
    await page.unroute('**/api/settings');
  }
  await closeSettings();
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Browse plugins' }).click();
});

test('unmounting browser plugins releases pages and restores replaced slot contributions', async ({
  page,
  launch,
}) => {
  const { host, mock } = await launch({
    prepare(paths) {
      const folder = join(paths.plugins, 'replace-new');
      mkdirSync(folder);
      writeJson(join(folder, 'plugin.json'), {});
      writeFileSync(
        join(folder, 'web.js'),
        `
  export const inject = ["miniPrimitives","miniConversation","miniSlots"];

  export const apply = (ctx) => {
      const { miniPrimitives, miniConversation } = ctx;
        ctx.effect(() => ctx.miniSlots.register('conversation.history', signal => {
          const node = miniPrimitives.status('Replacement history');
          const render = () => { node.textContent = 'Replacement history: ' + (miniConversation.get().run?.state ?? 'idle'); };
          miniConversation.subscribe(['run'], render, signal); render();
          return node;
        }, { key: 'history', priority: 1 }));
        ctx.effect(() => ctx.miniSlots.register('sidebar.primary', signal => {
          const button = miniPrimitives.button('Replacement conversation', 'quiet');
          window.addEventListener('slot-test', () => {
            document.body.dataset.slotEvents = String(Number(document.body.dataset.slotEvents ?? 0) + 1);
          }, { signal });
          return { node: button, dispose() { document.body.dataset.slotDisposed = 'yes'; } };
        }, { key: 'new-conversation', priority: 1 }));
      };
  `,
      );
      cpSync(resolve('dist/docs/examples/browser-panel'), join(paths.plugins, 'browser-panel'), {
        recursive: true,
      });
      writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
        plugins: [
          { id: 'replace-new', name: '../../plugins/replace-new', client: true },
          {
            id: 'browser-panel',
            name: '../../plugins/browser-panel',
            client: true,
            config: { replaceComposer: true },
          },
        ],
      });
    },
  });
  await page.goto(host.url + '/#token=' + host.token);
  await expect(page.getByRole('button', { name: 'Replacement conversation' })).toBeVisible();
  const replacement = page.getByRole('textbox', { name: 'Replacement message' });
  await replacement.fill('Hello from replacement');
  const attachments = page.getByLabel('Replacement attachments');
  await attachments.setInputFiles([
    { name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('kept attachment') },
    { name: 'remove.txt', mimeType: 'text/plain', buffer: Buffer.from('removed attachment') },
  ]);
  await page.getByRole('button', { name: 'Remove remove.txt' }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Messages' })).toHaveCount(0);
  let releaseResponse = () => {};
  const responseHeld = new Promise<void>((resume) => {
    releaseResponse = resume;
  });
  let sendAccepted = () => {};
  const accepted = new Promise<void>((resolve) => {
    sendAccepted = resolve;
  });
  await page.route(
    '**/api/sessions/*/runs',
    async (route) => {
      const result = await route.fetch();
      sendAccepted();
      await responseHeld;
      await route.fulfill({ response: result });
    },
    { times: 1 },
  );
  try {
    await page.getByRole('button', { name: 'Send replacement message' }).click();
    await accepted;
    await replacement.fill('New draft after submission');
  } finally {
    releaseResponse();
  }
  await expect(page.getByText('Replacement history: completed')).toBeVisible();
  expect(JSON.stringify(mock.requests)).toContain('kept attachment');
  expect(JSON.stringify(mock.requests)).not.toContain('removed attachment');
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('slot-test')));
  await expect(page.locator('body')).toHaveAttribute('data-slot-events', '1');

  await page.getByRole('button', { name: 'Example panel', exact: true }).click();
  await expect(page.getByText('Example panel is ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Example preview' })).toBeVisible();
  const settings = await fetch(host.url + '/api/settings', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + host.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: { 'replace-new': { disabled: true }, 'browser-panel': { disabled: true } },
    }),
  });
  expect(settings.status).toBe(200);
  await expect(page.getByRole('dialog', { name: 'Example preview' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Example panel', exact: true })).toHaveCount(0);
  await expect(page.getByText('Example panel is ready.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replacement conversation' })).toHaveCount(0);
  await expect(replacement).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Messages' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
    'New draft after submission',
  );
  const submitted = page.locator('#messages .message.user');
  await expect(submitted).toContainText('Hello from replacement');
  await expect(
    page
      .locator('#messages .message-row.user .message-attachments')
      .getByRole('button', { name: 'Preview keep.txt' }),
  ).toContainText('keep.txt');
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-slot-disposed', 'yes');
  await page.evaluate(() => window.dispatchEvent(new Event('slot-test')));
  await expect(page.locator('body')).toHaveAttribute('data-slot-events', '1');
});

test('the open model picker follows local plugin installation, enablement and removal', async ({
  page,
  launch,
}) => {
  const { host, paths } = await launch();
  await page.goto(host.url + '/#token=' + host.token);
  await modelButton(page).click();
  await modelSearch(page).fill('Live plugin model');
  const options = page.getByRole('listbox', { name: 'Configured models' }).getByRole('option');
  await expect(options).toHaveCount(0);
  const folder = join(paths.plugins, 'live-model');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ title: 'Live model' }));
  writeFileSync(
    join(folder, 'plugin.js'),
    `
export const inject = ['harnessModels'];
export function apply(ctx) {
const model = { provider: 'live-plugin', id: 'live' };
const resolve = (choice) => choice.provider === model.provider && choice.id === model.id ? model : undefined;
ctx.effect(() => ctx.harnessModels.register({
  list: () => [{ ...model, name: 'Live plugin model', configured: true, input: ['text'], thinkingLevels: [] }],
  resolve: (choice) => resolve(choice) && { model, capabilities: { id: model.id, name: 'Live plugin model', input: ['text'], contextWindow: 32000, maxTokens: 1024, reasoning: false } },
}, {
  accepts: (choice) => Boolean(resolve(choice)),
  async *stream() {
    yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'Live model answer' }], timestamp: Date.now(), stopReason: 'stop' } };
  },
}));
}
`,
  );
  const toggle = async (disabled: boolean) => {
    const response = await fetch(host.url + '/api/settings', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + host.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: { 'live-model': { name: '../../plugins/live-model', disabled } } }),
    });
    expect(response.status, await response.text()).toBe(200);
  };
  await toggle(false);
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('Live plugin model');
  await toggle(true);
  await expect(options).toHaveCount(0);
  await toggle(false);
  await expect(options).toHaveCount(1);
  await modelSearch(page).press('Enter');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use the live plugin');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveText('Live model answer');
  await toggle(true);
  await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toBeVisible();
  const draft = page.getByRole('textbox', { name: 'Message', exact: true });
  await draft.fill('Keep the draft if the selected model disappears');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(modelSearch(page)).toBeFocused();
  await expect(draft).toHaveText('Keep the draft if the selected model disappears');
  await modelSearch(page).fill('Live plugin model');
  await expect(options).toHaveCount(0);
});
