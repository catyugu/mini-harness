import { expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { browserTest as test, chooseModel, expectInViewport } from '../support/browser.ts';
import { writePlugin } from '../support/plugin-fixture.ts';

test('copy, preview and revise a message with its image, and show persisted plugin records', async ({
  page,
  launch,
}) => {
  const { host, mock } = await launch({
    reply: ({ messages }) => 'Response: ' + messages.filter((entry) => entry.role === 'user').at(-1)?.content,
    prepare(paths) {
      const modelFile = join(paths.home, 'models.json');
      const models = readJson<{ providers: { 'local-mock': { models: { input: string[] }[] } } }>(modelFile, {
        providers: { 'local-mock': { models: [] } },
      });
      models.providers['local-mock'].models[0].input.push('image');
      writeJson(modelFile, models);
      const records = writePlugin(
        paths.plugins,
        'record-writer',
        {},
        `
export const inject = ["harnessRoutes","harnessSessions"];
export const apply = (ctx) => {
          ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/extensions/record-writer/record', async ({ body }) => {
            const { id, visible } = await body();
            return ctx.harnessSessions.records(id, { pluginId: 'record-writer', instanceId: 'record-writer' }).append( 'fixture', visible ? { kind: 'fixture', title: 'Saved record' } : undefined);
          }));
        };
`,
      );
      writeFileSync(
        join(records, 'web.js'),
        `
export const inject = ["miniConversation","miniMessages"];
import { browserPluginId } from "mini-harness/ui-runtime/plugin-settings";

export const apply = (ctx) => {
    const { miniConversation } = ctx;
    const signal = ctx.fiber.signal;
          const update = () => {
            const { session, history } = miniConversation.get();
            document.body.dataset.recordSession = session?.id ?? '';
            document.body.dataset.recordLeaf = history?.leafId ?? '';
          };
          miniConversation.subscribe(['session', 'history'], update, signal);
          update();
          ctx.effect(() => ctx.miniMessages.registerRecord(browserPluginId(ctx), 'fixture', (_record, { signal }) => {
            document.body.dataset.recordReleased = 'no';
            signal.addEventListener('abort', () => { document.body.dataset.recordReleased = 'yes'; }, { once: true });
            throw new Error('fixture record rendering failure');
          }));
        };
`,
      );
      writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
        plugins: [{ id: 'record-writer', name: '../../plugins/record-writer' }],
      });
    },
  });
  const mobile = { width: 390, height: 844 };
  await page.setViewportSize(mobile);
  await page.goto(host.url + '/#token=' + host.token);
  const prompt = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const assistant = page.locator('.message-row.assistant');
  const user = page.locator('.message-row.user');
  await prompt.fill('Original prompt');
  const picture = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 280;
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#composer input[type=file]').setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from(picture, 'base64'),
  });
  await send.click();
  await expect(assistant.locator('.message')).toHaveText('Response: Original prompt');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.body.dataset.copiedMessage = text;
        },
      },
    });
  });
  await assistant.getByRole('button', { name: 'Copy message' }).click();
  await expect(assistant.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-copied-message', 'Response: Original prompt');

  const thumbnail = user.locator('.message.user').getByRole('button', { name: 'Preview reference.png' });
  await expect
    .poll(() =>
      thumbnail.locator('img').evaluate((img) => {
        const { width, height } = img.getBoundingClientRect();
        return width / height;
      }),
    )
    .toBeCloseTo(480 / 280, 1);
  await thumbnail.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: 'reference.png' });
  await expectInViewport(preview, mobile);
  const image = preview.getByRole('img', { name: 'reference.png' });
  await expect(image).toHaveJSProperty('naturalWidth', 480);
  const toggleSize = preview.getByRole('button', { name: 'Actual size' });
  await expect(toggleSize).toHaveAttribute('aria-pressed', 'false');
  await toggleSize.click();
  await expect(image).toHaveCSS('width', '480px');
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(thumbnail).toBeFocused();

  await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'completed');
  const body = page.locator('body');
  const sessionId = await body.getAttribute('data-record-session');
  expect(sessionId).toBeTruthy();
  for (const visible of [true, false]) {
    const response = await page.request.post(host.url + '/api/extensions/record-writer/record', {
      headers: { Authorization: 'Bearer ' + host.token },
      data: { id: sessionId, visible },
    });
    expect(response.ok()).toBe(true);
    const leaf: string = await response.json();
    await expect(body).toHaveAttribute('data-record-leaf', leaf);
    await expect(page.getByText('Saved record', { exact: true })).toBeVisible();
    await expect(body).toHaveAttribute('data-record-released', 'yes');
  }
  const edit = user.getByRole('button', { name: 'Edit message' });
  await edit.click();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveText('Original prompt');
  const navigation = page.getByRole('button', { name: 'Toggle navigation' });
  const editMode = page.getByRole('button', { name: 'Cancel editing' });
  await prompt.fill('Unsaved revision');
  await navigation.click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(editMode).toBeHidden();
  await prompt.fill('Independent draft');
  await navigation.click();
  await page.getByRole('button', { name: 'Original prompt', exact: true }).click();
  await expect(prompt).toHaveText('Unsaved revision');
  await expect(editMode).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove reference.png' });
  await expect(remove).toBeVisible();
  await prompt.fill('Revised prompt');
  await send.click();
  await expect(assistant.locator('.message')).toHaveText('Response: Revised prompt');
  await expect(user.getByRole('img', { name: 'reference.png' })).toHaveCount(1);
  expect(JSON.stringify(mock.requests.at(-1))).toContain('image_url');
  await edit.click();
  await remove.click();
  await prompt.fill('Removed picture');
  await send.click();
  await expect(assistant.locator('.message')).toHaveText('Response: Removed picture');
  await expect(user.getByRole('img', { name: 'reference.png' })).toHaveCount(0);
  expect(JSON.stringify(mock.requests.at(-1))).not.toContain('image_url');
  await edit.click();
  await prompt.fill('Discarded revision');
  await navigation.click();
  await page.getByRole('button', { name: 'Delete Original prompt', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete conversation' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(editMode).toBeHidden();
  await expect(prompt).toHaveText('Independent draft');
});

test('image validation keeps the draft available for an image-capable model', async ({ page, launch }) => {
  const { host, mock } = await launch({
    prepare(paths) {
      const file = join(paths.home, 'models.json');
      const config = readJson<{ providers: { 'local-mock': { models: Record<string, unknown>[] } } }>(file, {
        providers: { 'local-mock': { models: [] } },
      });
      const models = config.providers['local-mock'].models;
      models.push({ ...models[0], id: 'vision-model', input: ['text', 'image'] });
      writeJson(file, config);
    },
  });
  await page.goto(host.url + '/#token=' + host.token);
  await page
    .locator('#composer input[type=file]')
    .setInputFiles(resolve('packages/ui-runtime/src/assets/icon-192.png'));
  const attachment = page.getByRole('button', { name: 'Remove icon-192.png' });
  await expect(attachment).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read the picture');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'does not support image input' })).toBeVisible();
  await expect(page.locator('.run-termination')).toHaveCount(0);
  await expect(attachment).toBeVisible();
  expect(mock.requests).toHaveLength(0);
  await chooseModel(page, 'vision-model');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  expect(JSON.stringify(mock.requests.at(-1))).toContain('image_url');
  await expect(
    page.locator('.message-row.user .message-attachments').getByRole('img', { name: 'icon-192.png' }),
  ).toHaveCount(1);
  await expect(attachment).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  await expect(page.locator('.run-termination')).toHaveCount(0);
});
