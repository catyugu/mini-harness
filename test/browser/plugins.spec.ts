import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, realpathSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { workspaceId } from '@mini-harness/workspaces/catalog';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { startIsolatedHost, settingsSection, suggestions } from '../support/browser.js';

test('frontend plugins own UI contributions and clean up on disable and reconfiguration', async ({ page }) => {
  const mock = await createMockProvider(({ messages }) => messages.at(-1)?.role === 'tool' ? 'Done' : { tool: 'ls', args: {} });
  const { root, paths } = createFixturePaths(mock.url), folder = join(paths.plugins, 'ui-example'); mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), 'export default function() {}');
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ browserInject: ['miniSlots', 'miniTabs', 'miniSettingsRegistry', 'miniPrimitives', 'miniComposer', 'miniMessages'], title: 'UI example', icon: {
    path: 'M2 2h20v20H2z', viewBox: '0 0 24 24'
  }, configSchema: { type: 'object', properties: {
    label: { type: 'string', title: 'Button label', default: 'Plugin entry' },
    showDetails: { type: 'boolean', default: false }
  } } }));
  writeFileSync(join(folder, 'web.js'), `import { conversationExtensions, layoutExtensions, settingsExtensions, slotExtensions } from '/packages/ui-runtime/plugin-sdk.js';
  export default function({ miniPrimitives, miniComposer }, api) {
    for (const slot of ['sidebar','composer','inspector']) {
      const node = document.createElement('button');
      if (node.tagName === 'BUTTON') node.type = 'button';
      node.dataset.exampleSlot = slot; node.textContent = slot === 'sidebar' ? api.config.label : 'Plugin ' + slot;
      if (slot === 'composer') node.onclick = () => miniComposer.insert('Inserted by plugin');
      if (slot === 'inspector') node.onclick = () => {const p = document.createElement('p');p.textContent='Plugin preview';api.contribute(layoutExtensions.inspect, 'Example',p);};
      api.contribute(slotExtensions.register, {sidebar:'sidebar.actions',composer:'conversation.composer',inspector:'conversation.header'}[slot],node);
    }
    api.contribute(settingsExtensions.register, { section: 'General', id: 'preferences', order: 10, render({ bind }) {
      const content = document.createElement('div');
      const control = document.createElement('input');
      control.type = 'checkbox';
      content.append(miniPrimitives.field('Plugin preferences', control), bind(control, 'showDetails', {
        read(value) { control.checked = value; }, write() { return control.checked; }
      }));
      return content;
    } });
    for (const [section, id, text] of [
      ['Model', 'model', 'Plugin model preferences'],
      ['Extensions', 'extensions', 'Plugin settings']
    ]) {
      api.contribute(settingsExtensions.register, { section, id, order: 10, render() {
        const item = document.createElement('p');
        item.textContent = text;
        return item;
      } });
    }
    api.contribute(conversationExtensions.command, { name: 'example', description: 'Add a plugin note', run: () => miniComposer.insert('Plugin note') });
    api.contribute(conversationExtensions.tool, 'ls', () => { const node = document.createElement('p'); node.textContent = 'Custom listing result'; return node; });
  }`);
  const dependent = join(paths.plugins, 'a-dependent'); mkdirSync(dependent);
  writeFileSync(join(dependent, 'plugin.js'), 'export default function() {}');
  writeFileSync(join(dependent, 'plugin.json'), JSON.stringify({ title: 'Dependent UI', browserRequires: ['ui-example'], browserInject: ['miniSlots'] }));
  writeFileSync(join(dependent, 'web.js'), `import { slotExtensions } from '/packages/ui-runtime/plugin-sdk.js';
  export default function(_ctx, api) {
    const parent = document.querySelector('[data-example-slot=sidebar]');
    if (!parent) throw new Error('Dependency must mount first');
    const node = document.createElement('button'); node.type = 'button'; node.textContent = 'Dependent ' + parent.textContent; api.contribute(slotExtensions.register, 'sidebar.actions', node);
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
    await page.getByRole('button', { name: 'Plugin inspector', exact: true }).click();
    await expect(page.getByText('Plugin preview', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'General').click();
    await expect(page.getByRole('switch', { name: 'Add instructions' })).toBeVisible();
    const preferences = page.getByRole('checkbox', { name: 'Plugin preferences' });
    await expect(preferences).not.toBeChecked();
    await preferences.check();
    await expect(preferences).toBeEnabled();
    await expect(preferences).toBeChecked();
    expect(readJson<any>(paths.settings, {}).pluginConfig['ui-example']).toEqual({ showDetails: true });
    await settingsSection(page, 'Model').click();
    await expect(page.getByRole('button', { name: 'Add provider' })).toBeVisible();
    await expect(page.getByText('Plugin model preferences')).toBeVisible();
    await settingsSection(page, 'Extensions').click();
    await expect(page.getByText('Plugin settings', { exact: true })).toBeVisible();
    await expect(settingsSection(page, 'Plugins')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: 'Browse plugins', exact: true }).click();
    await expect(page.locator('[data-plugin-row="ui-example"] .plugin-symbol svg path'))
      .toHaveAttribute('d', 'M2 2h20v20H2z');
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
    await settingsSection(page, 'General').click();
    await expect(page.getByRole('switch', { name: 'Add instructions' })).toBeVisible();
    await expect(page.getByText('Plugin preferences', { exact: true })).toHaveCount(0);
    await expect(settingsSection(page, 'Extensions')).toBeHidden();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: 'Inserted by plugin', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/ex');
    await expect(suggestions(page).getByRole('option', { name: /Add a plugin note/ })).toHaveCount(0);
    await expect(page.locator('.tool-card')).toHaveAttribute('open', '');
    await expect(page.getByText('Custom listing result')).toHaveCount(0);
    await expect(page.locator('.tool-content pre').first()).toBeVisible();
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a failed browser plugin reports the saved state and can be retried', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const folder = join(paths.plugins, 'retry-ui');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), 'export default () => {}');
  writeJson(join(folder, 'plugin.json'), { title: 'Retry UI', browserInject: ['miniSlots'], browserAssets: ['web/preload.js'],
    browserPreload: 'web/preload.js', configSchema: {
    type: 'object', properties: { ready: { type: 'boolean', title: 'Ready', default: false } }
  } });
  mkdirSync(join(folder, 'web'));
  writeFileSync(join(folder, 'web/preload.js'), `export default (signal) => {
    document.body.dataset.retryPreload = 'mounted';
    return () => { document.body.dataset.retryPreload = signal.aborted ? 'released' : 'active'; };
  };`);
  writeFileSync(join(folder, 'web.js'), `import { slotExtensions } from '/packages/ui-runtime/plugin-sdk.js';
  export default (_ctx, api) => {
    const node = document.createElement('button');
    node.textContent = 'Recovered UI';
    api.contribute(slotExtensions.register, 'conversation.composer', node);
    if (!api.config.ready) throw new Error('Not ready');
  };`);
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
    await expect(page.locator('body')).toHaveAttribute('data-retry-preload', 'released');
    await page.getByRole('button', { name: 'Retry UI settings' }).click();
    await page.getByLabel('Ready · retry-ui').check();
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByRole('button', { name: 'Recovered UI' })).toHaveCount(1);
    await expect(page.locator('body')).toHaveAttribute('data-retry-preload', 'mounted');
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
    await expect(files).toBeChecked();
    await expect(files).toBeEnabled();
    let requests = 0, release: () => void = () => { throw new Error('Not started'); };
    const held = new Promise<void>((done) => { release = done; });
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
    await catalog.getByRole('button', { name: 'Install plugin', exact: true }).click();
    const install = page.getByRole('dialog', { name: 'Install plugin' });
    await install.getByLabel('Plugin ID', { exact: true }).fill('local-example');
    await expect(install.getByRole('button', { name: 'Install plugin', exact: true })).toBeDisabled();
    await install.getByLabel('Plugin bundle files').setInputFiles([{
      name: 'plugin.js', mimeType: 'text/javascript', buffer: Buffer.from('export default function setup() {}')
    }, { name: 'plugin.json', mimeType: 'application/json', buffer: Buffer.from('{}') }]);
    await expect(install.getByRole('list', { name: 'Selected files' }).getByRole('listitem')).toHaveText(['plugin.js', 'plugin.json']);
    await install.getByRole('button', { name: 'Install plugin', exact: true }).click();
    await expect(install).toBeHidden();
    await expect(catalog.getByRole('switch', { name: 'local-example', exact: true })).not.toBeChecked();
    await catalog.getByRole('button', { name: 'Subagents settings' }).click();
    await catalog.getByRole('spinbutton', { name: 'Maximum child depth · subagents' }).fill('2');
    await catalog.getByRole('button', { name: 'Save configuration' }).click();
    await expect(catalog.getByText('Saved.', { exact: true })).toBeVisible();
    const model = catalog.getByRole('combobox', { name: 'Child model · subagents' });
    await expect(model).toHaveValue('null');
    expect(readJson<any>(paths.settings, {}).pluginConfig.subagents.model).toBeNull();
    await model.selectOption({ label: 'Mock Model · local-mock' });
    await catalog.getByRole('button', { name: 'Save configuration' }).click();
    await expect(catalog.getByText('Saved.', { exact: true })).toBeVisible();
    expect(readJson<any>(paths.settings, {}).pluginConfig.subagents.model).toEqual({ provider: 'local-mock', id: 'mock-model' });
    await catalog.getByRole('button', { name: /All plugins/ }).click();
    await catalog.getByRole('button', { name: 'Subagents settings' }).click();
    await expect(catalog.getByRole('spinbutton', { name: 'Maximum child depth · subagents' })).toHaveValue('2');
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the Plugins page keeps stored settings when a workspace plugin setup fails and allows repair', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const folder = join(paths.plugins, 'workspace-example');
  mkdirSync(folder);
  writeJson(join(folder, 'plugin.json'), { scope: 'workspace', title: 'Workspace example', configSchema: {
    type: 'object', properties: { value: { type: 'integer', minimum: 1 } }, required: ['value']
  } });
  writeFileSync(join(folder, 'plugin.js'), "export default (_, api) => { if (api.config.value === 1) throw new Error('Workspace setup failed'); };");
  const key = 'workspace:' + workspaceId(realpathSync.native(paths.cwd));
  const initial = { ...readJson<Record<string, unknown>>(paths.settings, {}), scopes: {
    [key]: { plugins: { 'workspace-example': true }, pluginConfig: { 'workspace-example': { value: 'invalid' } } }
  } };
  writeJson(paths.settings, initial);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('button', { name: 'Browse plugins' }).click();
    await expect(page.getByRole('switch', { name: 'Workspace example' })).toBeChecked();
    await page.getByRole('button', { name: 'Workspace example settings' }).click();
    await expect(page.getByText('Invalid configuration for plugin: workspace-example')).toBeVisible();
    const value = page.getByRole('spinbutton', { name: 'value · workspace-example' });
    await value.fill('1');
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText(/Plugin workspace:.*\/workspace-example: Workspace setup failed/)).toBeVisible();
    expect(readJson<typeof initial>(paths.settings, initial).scopes[key].pluginConfig['workspace-example'].value).toBe('invalid');
    await value.fill('2');
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All plugins' }).click();
    await expect(page.getByRole('button', { name: 'Workspace example settings' })).toContainText('Ready');
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unmounting browser plugins releases pages and restores replaced slot contributions', async ({ page }) => {
  const mock = await createMockProvider();
  const { paths, root } = createFixturePaths(mock.url);
  let server: Awaited<ReturnType<typeof startIsolatedHost>> | undefined;
  try {
    const folder = join(paths.plugins, 'replace-new');
    mkdirSync(folder);
    writeJson(join(folder, 'plugin.json'), { browserInject: ['miniSlots', 'miniPrimitives', 'miniComposer', 'miniConversation'] });
    writeFileSync(join(folder, 'web.js'), `import { slotExtensions } from '/packages/ui-runtime/plugin-sdk.js';
    export default ({ miniPrimitives, miniConversation }, api) => {
      api.contribute(slotExtensions.keyed, 'conversation.composer-view', 'composer', signal => {
        const button = miniPrimitives.button('Replacement composer', 'quiet');
        button.addEventListener('click', () => void miniConversation.submit({ message: 'Hello from replacement' }).catch(miniConversation.report), { signal });
        return button;
      });
      api.contribute(slotExtensions.keyed, 'conversation.history', 'history', signal => {
        const node = miniPrimitives.status('Replacement history');
        const render = () => { node.textContent = 'Replacement history: ' + (miniConversation.get().run?.state ?? 'idle'); };
        miniConversation.subscribe(render, signal); render();
        return node;
      });
      api.contribute(slotExtensions.keyed, 'sidebar.primary', 'new-conversation', signal => {
        const button = miniPrimitives.button('Replacement conversation', 'quiet');
        window.addEventListener('slot-test', () => {
          document.body.dataset.slotEvents = String(Number(document.body.dataset.slotEvents ?? 0) + 1);
        }, { signal });
        return { node: button, dispose() { document.body.dataset.slotDisposed = 'yes'; } };
      });
    };`);
    cpSync(resolve('docs/examples/browser-panel'), join(paths.plugins, 'browser-panel'), { recursive: true });
    writeJson(paths.settings, { pluginConfig: { 'core:models': { model: { provider: 'local-mock', id: 'mock-model' } } }, plugins: { 'replace-new': true, 'browser-panel': true } });
    server = await startIsolatedHost(paths);
    await page.goto(server.url + '/#token=' + server.token);
    await expect(page.getByRole('button', { name: 'Replacement conversation' })).toBeVisible();
    await expect(page.getByText('Replacement composer')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
    await expect(page.locator('.message-image-dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Replacement composer' }).click();
    await expect(page.getByText('Replacement history: completed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('slot-test')));
    await expect(page.locator('body')).toHaveAttribute('data-slot-events', '1');

    await page.getByRole('button', { name: 'Example panel', exact: true }).click();
    await expect(page.getByText('Example panel is ready.')).toBeVisible();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Example preview' })).toBeVisible();
    const settings = await fetch(server.url + '/api/settings', {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: { 'replace-new': false, 'browser-panel': false } })
    });
    expect(settings.status).toBe(200);
    await expect(page.getByRole('dialog', { name: 'Example preview' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Example panel', exact: true })).toHaveCount(0);
    await expect(page.getByText('Example panel is ready.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Replacement conversation' })).toHaveCount(0);
    await expect(page.getByText('Replacement composer')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expect(page.locator('.message-image-dialog')).toHaveCount(1);
    await expect(page.locator('#messages .message.user').getByText('Hello from replacement', { exact: true })).toBeVisible();
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
