import { expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { browserTest as test, chooseModel, expectInViewport } from '../support/browser.js';

test('copy, preview and revise a message with its image, and release editing drafts by owner', async ({ page, launch }) => {
  const { host, mock } = await launch({
    reply: ({ messages }) => 'Response: ' + messages.filter((entry) => entry.role === 'user').at(-1)?.content,
    prepare(paths) {
      const modelFile = join(paths.home, 'models.json');
      const models = readJson<{ providers: { 'local-mock': { models: { input: string[] }[] } } }>(modelFile, {
        providers: { 'local-mock': { models: [] } }
      });
      models.providers['local-mock'].models[0].input.push('image');
      writeJson(modelFile, models);
      for (const [id, label] of [['old-editor', 'Older draft'], ['new-editor', 'Newer draft']]) {
        const folder = join(paths.plugins, id);
        mkdirSync(folder);
        writeJson(join(folder, 'plugin.json'), { browserInject: ['miniComposer', 'miniSlots'] });
        writeFileSync(join(folder, 'web.js'), `import { conversationExtensions, slotExtensions } from '/packages/ui-runtime/plugin-sdk.js';
          export default (_ctx, api) => {
            const label = ${JSON.stringify(label)};
            const control = document.createElement('button');
            control.textContent = label;
            control.onclick = () => api.contribute(conversationExtensions.draft, {
              title: label, text: label, revision: { sourceEntryId: 'fixture', expectedLeafId: null }
            });
            api.contribute(slotExtensions.register, 'sidebar.actions', control);
          };`);
      }
      const settings = readJson<Record<string, unknown>>(paths.settings, {});
      writeJson(paths.settings, { ...settings, plugins: { 'old-editor': true, 'new-editor': true } });
    }
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
    canvas.width = 480; canvas.height = 280;
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#composer input[type=file]').setInputFiles({
    name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(picture, 'base64')
  });
  await send.click();
  await expect(assistant.locator('.message')).toHaveText('Response: Original prompt');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { document.body.dataset.copiedMessage = text; } }
    });
  });
  await assistant.getByRole('button', { name: 'Copy message' }).click();
  await expect(assistant.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-copied-message', 'Response: Original prompt');

  const thumbnail = user.getByRole('button', { name: 'Preview reference.png' });
  await thumbnail.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: 'Image preview' });
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

  const edit = user.getByRole('button', { name: 'Edit message' });
  await edit.click();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('Original prompt');
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

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Older draft', exact: true }).click();
  await page.getByRole('button', { name: 'Newer draft', exact: true }).click();
  await expect(prompt).toHaveValue('Newer draft');
  async function disablePlugin(id: string) {
    const response = await page.request.patch(host.url + '/api/settings', {
      headers: { Authorization: 'Bearer ' + host.token }, data: { plugins: { [id]: false } }
    });
    expect(response.ok()).toBe(true);
  }
  await disablePlugin('old-editor');
  await expect(page.getByRole('button', { name: 'Older draft' })).toHaveCount(0);
  await expect(prompt).toHaveValue('Newer draft');
  await disablePlugin('new-editor');
  await expect(page.getByRole('button', { name: 'Cancel editing' })).toBeHidden();

  await page.getByRole('button', { name: 'Browse plugins' }).click();
  const helper = page.getByRole('switch', { name: 'Session helper', exact: true });
  await helper.uncheck();
  await expect(user.locator('.message-action')).toHaveCount(0);
  await expect(assistant.locator('.message-action')).toHaveCount(0);
  await helper.check();
  await page.getByRole('button', { name: 'Original prompt', exact: true }).click();
  await expect(edit).toBeVisible();
  await expect(assistant.getByRole('button', { name: 'Copy message' })).toBeVisible();
});

test('retry keeps the attachment when switching to an image-capable model', async ({ page, launch }) => {
  const { host, mock } = await launch({
    prepare(paths) {
      const file = join(paths.home, 'models.json');
      const config = readJson<{ providers: { 'local-mock': { models: Record<string, unknown>[] } } }>(file, {
        providers: { 'local-mock': { models: [] } }
      });
      const models = config.providers['local-mock'].models;
      models.push({ ...models[0], id: 'vision-model', input: ['text', 'image'] });
      writeJson(file, config);
    }
  });
  await page.goto(host.url + '/#token=' + host.token);
  await page.locator('#composer input[type=file]').setInputFiles(resolve('packages/ui-runtime/src/assets/icon-192.png'));
  const attachment = page.getByRole('button', { name: 'Remove icon-192.png' });
  await expect(attachment).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read the picture');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.message.error')).toContainText('does not support image input');
  await expect(attachment).toBeVisible();
  await chooseModel(page, 'vision-model');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  expect(JSON.stringify(mock.requests.at(-1))).toContain('image_url');
  await expect(page.locator('.message.user').getByRole('img', { name: 'icon-192.png' })).toHaveCount(1);
  await expect(attachment).toHaveCount(0);
});
