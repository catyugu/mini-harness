import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFixturePaths, createMockProvider } from '../support/mock-provider.ts';
import { writeJson } from '@mini-harness/platform/json';
import {
  readWebProfile,
  startIsolatedHost,
  settingsSection,
  suggestions,
  modelButton,
  modelSearch,
} from '../support/browser.ts';

test('frontend plugins own UI contributions and clean up on disable and reconfiguration', async ({
  page,
}) => {
  const mock = await createMockProvider(({ messages }) =>
    messages.at(-1)?.role === 'tool' ? 'Done' : { tool: 'ls', args: {} },
  );
  const { root, paths } = createFixturePaths(mock.url),
    folder = join(paths.plugins, 'ui-example');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'plugin.js'),
    "import { defineConfig } from 'mini-harness/configuration';\nimport { readFileSync } from 'node:fs';\nexport const Config = defineConfig(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')));",
  );
  writeFileSync(
    join(folder, 'schema.json'),
    JSON.stringify({
      type: 'object',
      properties: {
        label: { type: 'string', title: 'Button label', default: 'Plugin entry' },
        showDetails: { type: 'boolean', default: false },
      },
    }),
  );
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({
      title: 'UI example',
      icon: {
        path: 'M2 2h20v20H2z',
        viewBox: '0 0 24 24',
      },
    }),
  );
  writeFileSync(
    join(folder, 'web.js'),
    `
export const inject = ["miniPrimitives","miniComposer","miniTabs","miniSlots","miniSettingsRegistry","miniMessages"];
export const provide = ["exampleUi"];
import { browserPluginId, browserPluginSettings } from "mini-harness/ui-runtime/plugin-settings";

export function apply(ctx, config) {
    const signal = ctx.fiber.signal;
    const { miniPrimitives, miniComposer } = ctx;
    const context = document.createElement('span');
    context.textContent = 'Custom header context';
    ctx.effect(() => ctx.miniSlots.register('header.context', context));
    for (const slot of ['sidebar','composer','inspector']) {
      const node = document.createElement('button');
      if (node.tagName === 'BUTTON') node.type = 'button';
      node.dataset.exampleSlot = slot; node.textContent = slot === 'sidebar' ? config.label : 'Plugin ' + slot;
      if (slot === 'composer') node.onclick = () => miniComposer.insert('Inserted by plugin');
      if (slot === 'inspector') {
        let opened = 0;
        node.onclick = () => {
          const panel = document.createElement('p');
          panel.textContent = ++opened === 1 ? 'Plugin preview' : 'Updated plugin preview';
          ctx.miniTabs.inspect('Example', panel, signal);
        };
      }
      if (slot === 'sidebar') ctx.provide('exampleUi', node);
      ctx.effect(() => ctx.miniSlots.register({sidebar:'sidebar.actions',composer:'conversation.composer',inspector:'header.actions'}[slot], node));
    }
    ctx.effect(() => ctx.miniSettingsRegistry.register(browserPluginId(ctx), { section: 'General', id: 'preferences', order: 10, render({ bind }) {
      const content = document.createElement('div');
      const control = document.createElement('input');
      control.type = 'checkbox';
      content.append(miniPrimitives.field('Plugin preferences', control), bind(control, 'showDetails', {
        read(value) { control.checked = value; }, write() { return control.checked; }
      }));
      return content;
    } }, browserPluginSettings(ctx)));
    for (const [section, id, text] of [
      ['Model', 'model', 'Plugin model preferences'],
      ['Extensions', 'extensions', 'Plugin settings']
    ]) {
      ctx.effect(() => ctx.miniSettingsRegistry.register(browserPluginId(ctx), { section, id, order: 10, render() {
        const item = document.createElement('p');
        item.textContent = text;
        return item;
      } }, browserPluginSettings(ctx)));
    }
    ctx.effect(() => ctx.miniComposer.command({ name: 'example', description: 'Add a plugin note', run: () => miniComposer.insert('Plugin note') }));
    ctx.effect(() => ctx.miniMessages.registerTool('ls', () => { const node = document.createElement('p'); node.textContent = 'Custom listing result'; return node; }));
  }
`,
  );
  const dependent = join(paths.plugins, 'a-dependent');
  mkdirSync(dependent);
  writeFileSync(join(dependent, 'plugin.js'), 'export function apply() {}');
  writeFileSync(join(dependent, 'plugin.json'), JSON.stringify({ title: 'Dependent UI' }));
  writeFileSync(
    join(dependent, 'web.js'),
    `
export const inject = ["miniSlots", "exampleUi"];

export function apply(ctx) {
    const parent = ctx.exampleUi;
    if (!parent) throw new Error('Dependency must mount first');
    const node = document.createElement('button'); node.type = 'button'; node.textContent = 'Dependent ' + parent.textContent; ctx.effect(() => ctx.miniSlots.register('sidebar.actions', node));
    ctx.effect(() => () => { document.documentElement.dataset.dependencyDisposal = parent.isConnected ? 'ordered' : 'incorrect'; });
  }
`,
  );
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [
      { id: 'ui-example', name: '../../plugins/ui-example', client: true },
      { id: 'a-dependent', name: '../../plugins/a-dependent', client: true },
    ],
  });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await expect(page.getByRole('button', { name: 'Plugin entry', exact: true })).toBeVisible();
    await expect(page.getByText('Custom header context', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dependent Plugin entry', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Plugin composer', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
      'Inserted by plugin',
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Custom listing result')).toBeHidden();
    await expect(page.locator('.message.assistant')).toHaveText('Done');
    await page.locator('.tool-card summary').click();
    await expect(page.getByText('Custom listing result')).toBeVisible();
    await page.getByRole('button', { name: 'Plugin inspector', exact: true }).click();
    await expect(page.getByText('Plugin preview', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Plugin inspector', exact: true }).click();
    await expect(page.getByText('Updated plugin preview', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'General').click();
    await expect(page.getByRole('combobox', { name: 'Add instructions' })).toBeVisible();
    const preferences = page.getByRole('checkbox', { name: 'Plugin preferences' });
    await expect(preferences).not.toBeChecked();
    await preferences.check();
    await expect(preferences).toBeEnabled();
    await expect(preferences).toBeChecked();
    expect(readWebProfile(paths).configuration('ui-example')).toEqual({ showDetails: true });
    await settingsSection(page, 'Model').click();
    await expect(page.getByRole('button', { name: 'Add provider' })).toBeVisible();
    await expect(page.getByText('Plugin model preferences')).toBeVisible();
    await settingsSection(page, 'Extensions').click();
    await expect(page.getByText('Plugin settings', { exact: true })).toBeVisible();
    await settingsSection(page, 'Built-in plugins').click();
    const builtins = page.locator('.builtin-plugins');
    for (const title of ['Transport', 'Web Authentication', 'Plugin Runtime', 'Tool Executor']) {
      await expect(builtins.getByText(title, { exact: true })).toBeVisible();
      await expect(builtins.getByRole('switch', { name: title, exact: true })).toHaveCount(0);
    }
    await expect(builtins.getByRole('switch', { name: 'Context Management', exact: true })).toBeChecked();
    await expect(builtins.locator('svg')).toHaveCount(0);
    await expect(builtins.getByText('UI example', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: 'Browse plugins', exact: true }).click();
    await expect(page.locator('.catalog-group').first().locator('strong')).toHaveText([
      'Subagents',
      'Agent',
      'Shell',
    ]);
    await expect(page.locator('[data-plugin-row="core:transport"]')).toHaveCount(0);
    await expect(page.locator('[data-plugin-row="ui-example"] strong')).toHaveText('UI example');
    await expect(page.locator('[data-plugin-row="ui-example"] .plugin-symbol svg path')).toHaveAttribute(
      'd',
      'M2 2h20v20H2z',
    );
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
    await expect(page.getByText('Updated plugin preview', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'General').click();
    await expect(page.getByRole('combobox', { name: 'Add instructions' })).toBeVisible();
    await expect(page.getByText('Plugin preferences', { exact: true })).toHaveCount(0);
    await expect(settingsSection(page, 'Extensions')).toBeHidden();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: 'Inserted by plugin', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/ex');
    await expect(suggestions(page).getByRole('option', { name: /Add a plugin note/ })).toHaveCount(0);
    await expect(page.locator('.tool-card')).toHaveAttribute('open', '');
    await expect(page.getByText('Custom listing result')).toHaveCount(0);
    await expect(page.locator('.tool-content pre').first()).toBeVisible();
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed browser plugin reports the saved state and can be retried', async ({ page }) => {
  const mock = await createMockProvider(),
    { root, paths } = createFixturePaths(mock.url);
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

export const apply = (ctx, config) => {
    ctx.effect(() => {
      document.body.dataset.retryEffect = 'mounted';
      return () => { document.body.dataset.retryEffect = 'released'; };
    });
    const node = document.createElement('button');
    node.textContent = 'Recovered UI';
    ctx.effect(() => ctx.miniSlots.register('conversation.composer', node));
    if (!config.ready) throw new Error('Not ready');
  };
`,
  );
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [{ id: 'retry-ui', name: '../../plugins/retry-ui', disabled: true }],
  });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Browse plugins' }).click();
    const control = page.getByRole('switch', { name: 'Retry UI' });
    await control.check();
    await expect(page.getByText('Saved on the server. Browser plugins failed: retry-ui')).toBeVisible();
    await expect(control).toBeChecked();
    await expect(page.getByRole('button', { name: 'Recovered UI', includeHidden: true })).toHaveCount(0);
    await expect(page.getByText(/Browser setup failed.*Not ready/)).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-retry-effect', 'released');
    await page.getByRole('button', { name: 'Retry UI settings' }).click();
    await page.getByLabel('Ready · retry-ui').check();
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByRole('button', { name: 'Recovered UI' })).toHaveCount(1);
    await expect(page.locator('body')).toHaveAttribute('data-retry-effect', 'mounted');
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin catalog applies configuration and removes disabled browser capabilities', async ({ page }) => {
  const mock = await createMockProvider(),
    { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(service.url + '/#token=' + service.token);
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
      page
        .locator('#sidebarExtensions')
        .getByRole('button', { name: 'Workspace files', includeHidden: true }),
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
      await expect(
        page.getByRole('status').filter({ hasText: 'The switch could not be saved' }),
      ).toBeVisible();
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
    await expect(catalog.getByRole('button', { name: 'Install plugin' })).toHaveCount(0);
    await catalog.getByRole('button', { name: 'Subagents settings' }).click();
    await expect(catalog.locator('[name="plugin-scope"]')).toHaveCount(0);
    await expect(catalog.getByRole('switch', { name: 'Enabled in this scope' })).toHaveCount(0);
    await catalog.getByRole('spinbutton', { name: 'Maximum child depth · subagents' }).fill('2');
    await catalog.getByRole('button', { name: 'Save configuration' }).click();
    await expect(catalog.getByText('Saved.', { exact: true })).toBeVisible();
    const model = catalog.getByRole('combobox', { name: 'Child model · subagents' });
    await expect(model).toHaveValue('null');
    expect(readWebProfile(paths).configuration('subagents')?.model).toBeNull();
    await model.selectOption({ label: 'Mock Model · local-mock' });
    await catalog.getByRole('button', { name: 'Save configuration' }).click();
    await expect(catalog.getByText('Saved.', { exact: true })).toBeVisible();
    expect(readWebProfile(paths).configuration('subagents')?.model).toEqual({
      provider: 'local-mock',
      id: 'mock-model',
    });
    await catalog.getByRole('button', { name: /All plugins/ }).click();
    await catalog.getByRole('button', { name: 'Subagents settings' }).click();
    await expect(catalog.getByRole('spinbutton', { name: 'Maximum child depth · subagents' })).toHaveValue(
      '2',
    );
    await catalog.getByRole('button', { name: /All plugins/ }).click();
    const configureModels = async (disabled: boolean) => {
      const response = await page.request.patch(service.url + '/api/settings', {
        headers: { Authorization: 'Bearer ' + service.token },
        data: { entries: { 'core:model-admin': { disabled } } },
      });
      expect(response.ok()).toBe(true);
      await page.reload();
      await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.getByRole('button', { name: 'Browse plugins' }).click();
    };
    await configureModels(true);
    await catalog.getByRole('button', { name: 'Subagents settings' }).click();
    await expect(catalog.getByRole('textbox', { name: 'Child model · subagents' })).toHaveValue(
      JSON.stringify({ provider: 'local-mock', id: 'mock-model' }, null, 2),
    );
    await catalog.getByRole('button', { name: /All plugins/ }).click();
    await configureModels(false);
    await catalog.getByRole('button', { name: 'Subagents settings' }).click();
    await expect(catalog.getByRole('combobox', { name: 'Child model · subagents' })).toHaveValue(
      JSON.stringify({ provider: 'local-mock', id: 'mock-model' }),
    );
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  } finally {
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Web plugin manager excludes entries declared only in scoped Profile composition', async ({
  page,
}) => {
  const mock = await createMockProvider(),
    { root, paths } = createFixturePaths(mock.url);
  const folder = join(paths.plugins, 'workspace-example');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'schema.json'),
    JSON.stringify({
      type: 'object',
      properties: { value: { type: 'integer', minimum: 1 } },
      required: ['value'],
    }),
  );
  writeJson(join(folder, 'plugin.json'), {
    title: 'Workspace example',
  });
  writeFileSync(
    join(folder, 'plugin.js'),
    "import { defineConfig } from 'mini-harness/configuration';\nimport { readFileSync } from 'node:fs';\nexport const Config = defineConfig(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')));\nexport const apply = (ctx, config) => { if (config.value === 1) throw new Error('Workspace setup failed'); };",
  );
  let service = await startIsolatedHost(paths);
  try {
    const workspaces = await page.request.get(service.url + '/api/workspaces', {
      headers: { Authorization: 'Bearer ' + service.token },
    });
    expect(workspaces.ok()).toBe(true);
    const [workspace] = await workspaces.json();
    const key = 'workspace:' + workspace.id;
    await service.stop();
  const initial = {
    scopes: {
      [key]: {
        entries: {
          'workspace-example': {
            name: '../../plugins/workspace-example',
            disabled: false,
            config: { value: 'invalid' },
          },
        },
      },
    },
  };
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), initial);
    service = await startIsolatedHost(paths);
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Browse plugins' }).click();
    await expect(page.getByRole('button', { name: 'Workspace example settings' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Workspace example' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'Built-in plugins').click();
    await expect(page.locator('.builtin-plugins').getByText('Workspace example')).toHaveCount(0);
    const response = await page.request.get(service.url + '/api/plugins', {
      headers: { Authorization: 'Bearer ' + service.token },
    });
    expect(response.ok()).toBe(true);
    const plugins = await response.json();
    expect(plugins.some(({ id }: { id: string }) => id === 'workspace-example')).toBe(false);
    expect(plugins.every((plugin: object) => !('instances' in plugin))).toBe(true);
    expect(readWebProfile(paths).scopes[key].entries['workspace-example']?.config?.value).toBe('invalid');
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmounting browser plugins releases pages and restores replaced slot contributions', async ({
  page,
}) => {
  const mock = await createMockProvider();
  const { paths, root } = createFixturePaths(mock.url);
  let server: Awaited<ReturnType<typeof startIsolatedHost>> | undefined;
  try {
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
    server = await startIsolatedHost(paths);
    await page.goto(server.url + '/#token=' + server.token);
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
    const settings = await fetch(server.url + '/api/settings', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' },
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
  } finally {
    await server?.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the open model picker follows local plugin installation, enablement and removal', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
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
  const resolve = (choice) => choice.provider === model.provider ? model : undefined;
  ctx.effect(() => ctx.harnessModels.register({
    list: () => [{ ...model, name: 'Live plugin model', configured: true, input: ['text'], thinkingLevels: [] }],
    resolve,
    capabilities: () => ({ id: model.id, name: 'Live plugin model', input: ['text'], contextWindow: 32000, maxTokens: 1024, reasoning: false }),
  }, {
    accepts: (choice) => Boolean(resolve(choice)),
    async *stream() {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'Live model answer' }], timestamp: Date.now() } };
    },
  }));
}
`,
    );
    const toggle = async (disabled: boolean) => {
      const response = await fetch(service.url + '/api/settings', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + service.token, 'Content-Type': 'application/json' },
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
    await modelButton(page).click();
    await modelSearch(page).fill('Live plugin model');
    await expect(options).toHaveCount(0);
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
