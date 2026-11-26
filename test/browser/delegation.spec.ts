import { expectPresent } from '../support/required.ts';
import { test, expect } from '@playwright/test';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.ts';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { readWebProfile, startIsolatedHost } from '../support/browser.ts';

test('plugin schema controls, recursive tree navigation, batch export and permanent deletion', async ({
  page,
}) => {
  const mock = await createMockProvider(({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model message');
    if (last.role === 'tool') return 'Delegation complete';
    if (last.content === 'Parent task') return { tool: 'delegate', args: { task: 'Child task' } };
    if (last.content.replace(/^\[agent[^\]]+\] /, '') === 'Child task')
      return { tool: 'delegate', args: { task: 'Leaf task' } };
    if (last.content.includes('Child run completed')) return 'Child report received';
    return 'Leaf result';
  });
  const { root, paths } = createFixturePaths(mock.url);
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [
      { id: 'subagents', config: { maxDepth: 2, maxParallel: 1, model: null } },
      { id: 'example', name: '../../plugins/example', disabled: true },
    ],
  });
  const folder = join(paths.plugins, 'example');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'schema.json'),
    JSON.stringify({
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
    }),
  );
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({
      title: 'Example',
    }),
  );
  writeFileSync(
    join(folder, 'plugin.js'),
    "import { defineConfig } from 'mini-harness/configuration';\nimport { readFileSync } from 'node:fs';\nexport const Config = defineConfig(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')));\nexport const apply = (ctx, config) => { if (config.prefix === \"bad\") throw new Error(\"Bad prefix\"); };",
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
    await expect(page.getByText('Delegation complete', { exact: true })).toBeVisible();
    await expect(page.getByText('Child report received', { exact: true }).first()).toBeVisible();
    const notification = page
      .locator('details.async-message')
      .filter({ hasText: 'Subagent finished' })
      .first();
    await expect(notification.locator('summary')).toBeVisible();
    await expect(notification.locator('article')).toBeHidden();
    await page.locator('.subagent-tasks').getByRole('button', { name: 'Subagents', exact: true }).click();
    const tasks = page.locator('.subagent-list');
    await expect(tasks).toBeVisible();
    await expect(page.locator('.background-tasks')).toBeHidden();
    await expect(page.locator('.subagent-tasks > button')).toHaveText('1 subagent');
    await expect(
      tasks.getByRole('button', { name: 'Open conversation: Child task', exact: true }),
    ).toHaveCount(1);
    await expect(tasks.locator('.task-output')).toHaveCount(0);
    await page.locator('.subagent-tasks').getByRole('button', { name: 'Subagents', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Parent task', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Child task', exact: true }).click();
    await page.getByRole('button', { name: 'Leaf task', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Leaf result');
    const instruction = page.locator('details.async-message').filter({ hasText: 'Agent message' }).first();
    await expect(instruction.locator('article')).toBeHidden();
    await instruction.locator('summary').click();
    await expect(instruction.locator('.markdown')).toContainText('Leaf task');
    const ancestors = page.getByRole('navigation', { name: 'Parent conversations' });
    await expect(ancestors.getByRole('button')).toHaveText(['Parent task', 'Child task']);
    await expect
      .poll(async () => {
        const workspace = await page.locator('#headerContext .workspace-button').boundingBox();
        const trail = await ancestors.boundingBox();
        return (
          workspace &&
          trail &&
          trail.x >= workspace.x + workspace.width &&
          Math.abs(trail.y + trail.height / 2 - workspace.y - workspace.height / 2) < 2
        );
      })
      .toBe(true);
    await ancestors.getByRole('button', { name: 'Child task', exact: true }).click();
    await expect(page.locator('#conversationTitle')).toHaveText('Child task');
    await page.locator('.subagent-tasks').getByRole('button', { name: 'Subagents', exact: true }).click();
    await tasks.getByRole('button', { name: 'Open conversation: Leaf task', exact: true }).click();
    await expect(page.locator('#conversationTitle')).toHaveText('Leaf task');
    await page.reload();
    await expect(page.locator('#conversationTitle')).toHaveText('Leaf task');
    await expect(page.locator('.session-row .run-state')).toHaveCount(0);
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
