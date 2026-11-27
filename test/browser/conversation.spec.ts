import { expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/json';
import {
  browserTest as test,
  modelSearch,
  suggestions,
  modelButton,
  chooseModel,
} from '../support/browser.ts';

test('workspace references and uploaded files stay with their conversation draft', async ({
  page,
  launch,
}) => {
  const { host, mock } = await launch({
    prepare(paths) {
      writeFileSync(join(paths.cwd, 'notes.md'), '# Notes\nTask details');
      const skill = join(paths.home, 'skills', 'review');
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(skill, 'SKILL.md'),
        '---\nname: review\ndescription: Review the work\n---\n\nReview carefully.',
      );
    },
  });
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto(host.url + '/#token=' + host.token);
  const draft = page.getByRole('textbox', { name: 'Message', exact: true });
  await draft.fill('/rev');
  await suggestions(page)
    .getByRole('option', { name: /Review the work/ })
    .click();
  await draft.press('End');
  await draft.press('Space');
  await draft.press('@');
  await suggestions(page).getByRole('option', { name: 'notes.md', exact: true }).click();
  await draft.getByRole('button', { name: 'notes.md', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Workspace panel' });
  await expect(panel.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await panel.getByRole('button', { name: 'Close workspace panel' }).click();

  await draft.fill('Read this /skill:review /file');
  const chooser = page.waitForEvent('filechooser');
  await draft.press('Enter');
  await (
    await chooser
  ).setFiles({ name: 'task.txt', mimeType: 'text/plain', buffer: Buffer.from('ATTACHED TASK') });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  await expect(page.getByRole('button', { name: 'Preview task.txt' })).toBeVisible();
  expect(JSON.stringify(mock.requests[0])).toContain('Review carefully.');

  await draft.fill('Keep this draft');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(draft.locator('.cm-placeholder')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Conversation tree' })
    .getByRole('button', { name: /^Read this \/skill:review$/, exact: true })
    .click();
  await expect(draft).toHaveText('Keep this draft');
});

test('the model picker filters providers and restores an accepted choice after reload', async ({
  page,
  launch,
}) => {
  const { host, mock } = await launch({
    prepare(paths) {
      const models = readJson<any>(join(paths.home, 'models.json'), {});
      const first = models.providers['local-mock'].models[0];
      models.providers['local-mock'].models.push({
        ...first,
        id: 'second-model',
        name: 'Second Model',
        reasoning: true,
      });
      models.providers['unconfigured-fixture'] = {
        baseUrl: models.providers['local-mock'].baseUrl,
        api: 'openai-completions',
        models: [{ ...first, id: 'private-only', name: 'Private Only' }],
      };
      writeJson(join(paths.home, 'models.json'), models);
    },
  });
  await page.goto(host.url + '/#token=' + host.token);
  await modelButton(page).click();
  await modelSearch(page).fill('private-only');
  await expect(page.getByText('No matching models.')).toBeVisible();
  await modelSearch(page).press('Escape');
  await chooseModel(page, 'local-mock second-model');
  await expect(modelButton(page)).toHaveText('Second Model');
  const thinking = page.locator('#thinkingLevel');
  await expect(thinking).toHaveAttribute('aria-label', 'Thinking level: Default');
  await thinking.click();
  const levels = page.getByRole('listbox', { name: 'Thinking levels' });
  await expect(levels).toBeVisible();
  await levels.getByRole('option', { name: 'High', exact: true }).click();
  await expect(thinking).toHaveAttribute('aria-label', 'Thinking level: High');
  await page.getByRole('textbox', { name: 'Message' }).fill('New model conversation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveText('Mock response');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  expect(mock.requests.at(-1)?.model).toBe('second-model');
  await expect(thinking).toHaveAttribute('aria-label', 'Thinking level: High');
  await page.reload();
  await expect(modelButton(page)).toHaveText('Second Model');
});

test('video attachments play in a dialog and workspace references play in the panel', async ({
  page,
  launch,
}) => {
  const video = readFileSync(new URL('../fixtures/preview.webm', import.meta.url));
  const { host } = await launch({
    prepare({ cwd }) {
      writeFileSync(join(cwd, 'clip.webm'), video);
    },
  });
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(host.url + '/#token=' + host.token);
  await page.locator('#composer input[type=file]').setInputFiles({
    name: 'upload.webm',
    mimeType: 'video/webm',
    buffer: video,
  });
  const card = page.getByRole('button', { name: 'Preview upload.webm' });
  await card.click();
  const media = page.getByRole('dialog', { name: 'upload.webm' });
  const playback = media.locator('video[controls]');
  await expect(playback).toBeVisible();
  await expect.poll(() => playback.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThan(1);
  await media.getByRole('button', { name: 'Close preview' }).click();
  await expect(card).toBeFocused();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Watch @"clip.webm"');
  const reference = page.locator('#prompt').getByRole('button', { name: 'clip.webm', exact: true });
  await reference.click();
  const panel = page.getByRole('dialog', { name: 'Workspace panel' });
  await expect(panel.locator('video[controls]')).toBeVisible();
  await expect(page.locator('.file-media-dialog')).toHaveCount(0);
});

test('crowded composer controls remain reachable in a short mobile viewport', async ({ page, launch }) => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { host } = await launch({
    async reply() {
      await pending;
      return 'Late response';
    },
    prepare(paths) {
      const folder = join(paths.plugins, 'composer-actions');
      mkdirSync(folder);
      writeJson(join(folder, 'plugin.json'), {});
      writeFileSync(
        join(folder, 'web.js'),
        `
export const inject = ['miniSlots', 'miniPrimitives', 'miniComposer'];
export function apply(ctx) {
  for (let number = 1; number <= 12; ++number) {
    const action = ctx.miniPrimitives.button('Extra action ' + number);
    action.onclick = () => ctx.miniComposer.insert('Inserted text');
    ctx.effect(() => ctx.miniSlots.register('conversation.composer', action));
  }
}
`,
      );
      writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
        plugins: [{ id: 'composer-actions', name: '../../plugins/composer-actions', client: true }],
      });
    },
  });
  try {
    await page.setViewportSize({ width: 320, height: 380 });
    await page.goto(host.url + '/#token=' + host.token);
    await page.getByRole('button', { name: 'More composer controls' }).click();
    await page.getByRole('button', { name: 'Extra action 12', exact: true }).click();
    await page.keyboard.press('Escape');
    const draft = page.getByRole('textbox', { name: 'Message' });
    await expect(draft).toHaveText('Inserted text');
    await draft.fill('Keep this /mo');
    await expect(suggestions(page).getByRole('option', { name: /Choose a configured model/ })).toBeVisible();
    await draft.press('Tab');
    await expect(draft).toHaveText('Keep this /model');
    await draft.press('Enter');
    await expect(modelSearch(page)).toBeFocused();
    await modelSearch(page).press('Escape');
    await expect(draft).toHaveText('Keep this');
    await expect(modelButton(page)).toBeFocused();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const stop = page.getByRole('button', { name: 'Stop response' });
    await expect(stop).toBeInViewport();
    await stop.click();
    await expect(page.getByLabel('Latest run')).toHaveAttribute('data-state', 'cancelled');
  } finally {
    release();
  }
});
