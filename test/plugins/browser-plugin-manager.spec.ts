import { test, expect } from '@playwright/test';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { readJson, writeJson } from '../../packages/platform/config.js';
import { startIsolatedHost, settingsSection, suggestions } from '../support/browser.js';

test('frontend plugins own all five slots and clean up on disable and reconfiguration', async ({ page }) => {
  const mock = await createMockProvider(({ messages }) => messages.at(-1).role === 'tool' ? 'Done' : { tool: 'ls', args: {} });
  const { root, paths } = createFixturePaths(mock.url), folder = join(paths.plugins, 'ui-example'); mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), 'export default function() {}');
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ title: 'UI example', icon: {
    path: 'M2 2h20v20H2z', viewBox: '0 0 24 24'
  }, configSchema: { type: 'object', properties: { label: { type: 'string', title: 'Button label', default: 'Plugin entry' } } } }));
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
    await page.getByRole('button', { name: 'Open workspace panel', exact: true }).click();
    await page.getByRole('button', { name: 'Plugin inspector', exact: true }).click();
    await expect(page.getByText('Plugin preview', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'Example settings').click();
    await expect(page.getByText('Plugin preferences')).toBeVisible();
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

test('a failed browser plugin reports the saved state and can be retried', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const folder = join(paths.plugins, 'retry-ui');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.js'), 'export default () => {}');
  writeJson(join(folder, 'plugin.json'), { title: 'Retry UI', configSchema: {
    type: 'object', properties: { ready: { type: 'boolean', title: 'Ready', default: false } }
  } });
  writeFileSync(join(folder, 'web.js'), `export default (api) => {
    const node = document.createElement('button');
    node.textContent = 'Recovered UI';
    api.mount('composer', node);
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
    await page.getByRole('button', { name: 'Retry UI settings' }).click();
    await page.getByLabel('Ready · retry-ui').check();
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByRole('button', { name: 'Recovered UI' })).toHaveCount(1);
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
    // An empty but schema-required string must not block form submission or be omitted.
    const childConfig = readJson<any>(paths.settings, {}).pluginConfig.subagents;
    expect(childConfig.provider).toBe('');
    expect(childConfig.model).toBe('');
    await catalog.getByRole('button', { name: /All plugins/ }).click();
    await catalog.getByRole('button', { name: 'Subagents settings' }).click();
    await expect(catalog.getByRole('spinbutton', { name: 'Maximum child depth · subagents' })).toHaveValue('2');
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  } finally { await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
