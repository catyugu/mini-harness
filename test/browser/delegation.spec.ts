import { expectPresent } from '../support/required.js';
import { test, expect } from '@playwright/test';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { readWebProfile, startIsolatedHost } from '../support/browser.js';

test('plugin schema controls, recursive tree navigation, batch export and permanent deletion', async ({
  page,
}) => {
  const mock = await createMockProvider(({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model message');
    if (last.role === 'tool') return 'Delegation complete';
    if (last.content === 'Parent task') return { tool: 'delegate', args: { task: 'Child task' } };
    if (last.content === 'Child task') return { tool: 'delegate', args: { task: 'Leaf task' } };
    return 'Leaf result';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const settings = readJson<any>(paths.settings, {});
  writeJson(paths.settings, {
    ...settings,
    pluginConfig: { ...settings.pluginConfig, subagents: { maxDepth: 2, maxParallel: 1, model: null } },
  });
  const folder = join(paths.plugins, 'example');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({
      title: 'Example',
      configSchema: {
        type: 'object',
        required: ['prefix', 'count', 'mode'],
        additionalProperties: false,
        properties: {
          prefix: { type: 'string', title: 'Prefix', default: 'Count' },
          count: { type: 'integer', title: 'Count', minimum: 1, maximum: 9, default: 3 },
          mode: { type: 'string', title: 'Mode', enum: ['brief', 'full'], default: 'brief' },
          enabled: { type: 'boolean', title: 'Enabled', default: true },
          limits: {
            type: 'object',
            title: 'Limits',
            properties: { threshold: { type: 'number', title: 'Threshold', default: 0.5 } },
          },
          tags: { type: 'array', title: 'Tags', items: { type: 'string' }, default: ['base'] },
        },
      },
    }),
  );
  writeFileSync(
    join(folder, 'plugin.js'),
    'export const apply = (ctx, config) => { if (config.prefix === "bad") throw new Error("Bad prefix"); };',
  );
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
    await expect(
      page
        .getByRole('region', { name: 'Plugin catalog' })
        .getByRole('status')
        .filter({ hasText: /Saved|Bad prefix/ }),
    ).toHaveText('Saved.');
    expect(readWebProfile(paths).configuration('example')).toEqual({
      prefix: 'Total',
      count: 5,
      mode: 'full',
      enabled: false,
      limits: { threshold: 0.75 },
      tags: ['custom'],
    });
    await page.getByLabel('Prefix · example', { exact: true }).fill('bad');
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(
      page
        .getByRole('region', { name: 'Plugin catalog' })
        .getByRole('status')
        .filter({ hasText: /Saved|Bad prefix/ }),
    ).toContainText('Plugin example: Bad prefix');
    expect(readWebProfile(paths).configuration('example')?.prefix).toBe('Total');
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
    await page.getByRole('button', { name: 'Select conversations' }).click();
    await page.getByRole('checkbox', { name: 'Select Parent task', exact: true }).check();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exported = JSON.parse(readFileSync(await (await download).path(), 'utf8'));
    expect(exported.sessions).toHaveLength(3);
    expect(exported.sessions.every((item: { log: string }) => item.log.includes('"type":"message"'))).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Delete conversations' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.session-row')).toHaveCount(0);
    expect(readJson<any>(paths.registry, {}).sessions).toHaveLength(0);
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
