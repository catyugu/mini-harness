import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../support/mock-provider.ts';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { startIsolatedHost, modelSearch, suggestions, modelButton, chooseModel } from '../support/browser.ts';

test('drafts isolate attachments and discover workspace files and skills', async ({ page }) => {
  const mock = await createMockProvider(),
    { root, paths } = createFixturePaths(mock.url);
  const modelsPath = join(paths.home, 'models.json');
  const models = readJson<any>(modelsPath, {});
  models.providers['local-mock'].models[0].input.push('image');
  writeFileSync(modelsPath, JSON.stringify(models));
  writeFileSync(join(paths.cwd, 'notes.md'), '# Notes\nTask details');
  mkdirSync(join(paths.cwd, 'task files'));
  writeFileSync(join(paths.cwd, 'task files', 'draft.md'), '# Draft');
  const skill = join(paths.home, 'skills', 'review');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: review\ndescription: Review the work\n---\n\nReview carefully.',
  );
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    for (let i = 0; i < 3; i++)
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    const index = readJson<any>(paths.registry, { sessions: [] });
    expect(index.sessions).toHaveLength(0);
    const draft = page.getByRole('textbox', { name: 'Message', exact: true });
    await draft.fill('@');
    await suggestions(page).getByRole('option', { name: 'task files, expand folder' }).click();
    await suggestions(page).getByRole('option', { name: 'draft.md', exact: true }).click();
    await expect(draft.getByRole('button', { name: 'task files/draft.md', exact: true })).toBeVisible();
    await draft.fill('@');
    await suggestions(page).getByRole('option', { name: 'task files, expand folder' }).click();
    await suggestions(page).getByRole('option', { name: 'Reference task files/', exact: true }).click();
    await expect(draft.getByRole('button', { name: 'task files/', exact: true })).toBeVisible();
    await draft.fill('@notes');
    await suggestions(page).getByRole('option', { name: 'notes.md', exact: true }).click();
    const reference = draft.getByRole('button', { name: 'notes.md', exact: true });
    await expect(reference).toBeVisible();
    await reference.click();
    const panel = page.getByRole('complementary', { name: 'Workspace panel' });
    await expect(panel.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await panel.getByRole('button', { name: 'Close workspace panel' }).click();

    await draft.fill('Read this attachment  and keep this text');
    await draft.press('Home');
    for (let i = 0; i < 21; i++) await draft.press('ArrowRight');
    await draft.press('/');
    await draft.press('m');
    await draft.press('o');
    await expect(suggestions(page).getByRole('option', { name: /Choose a configured model/ })).toBeVisible();
    await draft.press('Tab');
    await expect(draft).toHaveText('Read this attachment /model and keep this text');
    await draft.press('Enter');
    await expect(modelSearch(page)).toBeFocused();
    await modelSearch(page).press('Escape');
    await expect(draft).toHaveText('Read this attachment  and keep this text');

    await draft.fill('Open https://example.test/model and /home/model');
    await expect(suggestions(page)).toBeHidden();
    const refreshed = join(paths.cwd, '.agents', 'skills', 'fresh');
    mkdirSync(refreshed, { recursive: true });
    writeFileSync(
      join(refreshed, 'SKILL.md'),
      '---\nname: fresh\ndescription: Added after connecting\n---\nFresh instructions.',
    );
    await draft.fill('');
    await page.getByRole('button', { name: 'Choose skill' }).click();
    await expect(suggestions(page).getByRole('option', { name: /Added after connecting/ })).toBeVisible();
    await draft.press('Escape');
    await draft.fill('Read this attachment  and keep this text');
    await draft.press('Home');
    for (let i = 0; i < 21; i++) await draft.press('ArrowRight');
    await draft.press('/');
    await draft.press('r');
    await draft.press('e');
    await draft.press('v');
    await expect(suggestions(page).getByRole('option', { name: /Review the work/ })).toBeVisible();
    await draft.press('Enter');
    await expect(draft).toHaveText('Read this attachment /skill:review and keep this text');
    const images = await page.evaluate(() =>
      [240, 480].map((width) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = (width * 7) / 12;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#137';
        context.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png').split(',')[1];
      }),
    );
    await draft.fill('Read this attachment /skill:review and keep this text /file');
    await expect(
      suggestions(page).getByRole('option', { name: /Upload files from your device/ }),
    ).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await draft.press('Enter');
    await (
      await chooser
    ).setFiles([
      { name: 'task.txt', mimeType: 'text/plain', buffer: Buffer.from('ATTACHED TASK') },
      { name: 'document.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') },
      { name: 'blue.png', mimeType: 'image/png', buffer: Buffer.from(images[0], 'base64') },
      { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(images[1], 'base64') },
    ]);
    await expect(page.getByRole('button', { name: 'Remove task.txt' })).toBeVisible();
    await page.getByRole('button', { name: 'Preview task.txt', exact: true }).click();
    await expect(panel.locator('.file-preview:visible')).toHaveText('ATTACHED TASK');
    await panel.getByRole('button', { name: 'Close workspace panel' }).click();
    await page.getByRole('button', { name: 'Preview blue.png', exact: true }).click();
    const media = page.getByRole('dialog', { name: 'blue.png' });
    await expect(media.getByRole('img')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(media).toHaveCount(0);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    const bubble = page.locator('.message.user').first();
    await expect(bubble).toContainText('Read this attachment /skill:review and keep this text');
    const row = page.locator('.message-row.user').first();
    const cards = row.locator('.message-attachments');
    await expect(cards.locator('img')).toHaveCount(2);
    await expect(cards.getByRole('img', { name: 'blue.png' })).toBeVisible();
    await expect(cards.getByRole('img', { name: 'reference.png' })).toBeVisible();
    await expect(cards.locator('.file-card')).toHaveCount(2);
    await expect(cards.getByRole('button', { name: 'Preview task.txt' })).toContainText('TXT · 13 B');
    await expect(cards.getByRole('button', { name: 'Preview document.pdf' })).toContainText('PDF');
    await expect(bubble.locator('.file-card, img')).toHaveCount(4);
    await cards.getByRole('button', { name: 'Preview task.txt' }).click();
    await expect(panel.locator('.file-preview:visible')).toHaveText('ATTACHED TASK');
    const fileDownload = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download', exact: true }).click();
    expect((await fileDownload).suggestedFilename()).toBe('task.txt');
    await panel.getByRole('button', { name: 'Close workspace panel' }).click();
    expect(JSON.stringify(mock.requests[0])).toContain('image_url');
    expect(JSON.stringify(mock.requests[0])).toContain('ATTACHED TASK');
    expect(JSON.stringify(mock.requests[0])).toContain('Review carefully.');
    expect(JSON.stringify(mock.requests[0])).toContain('Read this attachment and keep this text');
    await draft.fill('/export');
    const exported = page.waitForEvent('download');
    await draft.press('Enter');
    expect((await exported).suggestedFilename()).toBe('mini-harness-sessions.json');
    await expect(page.locator('.attachment')).toHaveCount(0);
    const original = page.locator('.session-name');
    const title = await original.textContent();
    if (!title) throw new Error('Conversation title is missing');
    await draft.fill('Keep this draft');
    await page.evaluate(() => {
      const read = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function (file) {
        window.setTimeout(() => read.call(this, file), 700);
      };
    });
    await page.locator('#composer input[type=file]').setInputFiles({
      name: 'private.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('ONLY FOR PROJECT REVIEW'),
    });
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(draft.locator('.cm-placeholder')).toBeVisible();
    await draft.fill('Different conversation @"notes.md"');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    expect(JSON.stringify(mock.requests.at(-1))).not.toContain('ONLY FOR PROJECT REVIEW');
    await expect(page.locator('.message-attachments')).toHaveCount(0);
    const historyReference = page
      .locator('.message.user')
      .getByRole('button', { name: 'notes.md', exact: true });
    await expect(historyReference).toBeVisible();
    await expect(page.locator('.message.user')).toHaveText('Different conversation notes.md');
    await historyReference.click();
    await expect(panel.getByRole('heading', { name: 'Notes' })).toBeVisible();
    const savedAttachment = panel.getByRole('tab', { name: 'task.txt', exact: true });
    await savedAttachment.click();
    await expect(panel.locator('.file-preview:visible')).toHaveText('ATTACHED TASK');
    await panel.getByRole('tab', { name: 'notes.md', exact: true }).click();
    await panel.getByRole('button', { name: 'Close workspace panel' }).click();
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(draft).toHaveText('Keep this draft');
    await expect(page.getByRole('button', { name: 'Remove private.txt' })).toBeVisible();
    await page.getByRole('button', { name: 'Open workspace panel', exact: true }).click();
    await expect(panel.getByRole('tab', { name: 'notes.md', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await panel.getByRole('button', { name: 'Close workspace panel' }).click();
    await page.locator('.session-row').filter({ hasText: 'Different conversation' }).hover();
    await page
      .getByRole('button', { name: 'Delete Different conversation @"notes.md"', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Delete conversation' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Different conversation @"notes.md"', exact: true }),
    ).toHaveCount(0);
    await page.locator('.session-row').filter({ hasText: title }).hover();
    await page.getByRole('button', { name: 'Delete ' + title, exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Delete conversation' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
    await page.getByRole('button', { name: 'Open workspace panel', exact: true }).click();
    await expect(panel.getByRole('tab', { name: 'notes.md', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(panel.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await savedAttachment.click();
    await expect(panel.getByRole('tabpanel', { name: 'task.txt' })).toContainText('Conversation not found');
    await panel.getByRole('tab', { name: 'notes.md', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Notes' })).toBeVisible();
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the global recent model survives history navigation and page reload', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const models = readJson<any>(join(paths.home, 'models.json'), {});
  const first = models.providers['local-mock'].models[0];
  models.providers['local-mock'].models.push({
    ...first,
    id: 'second-model',
    name: 'Second Model',
    reasoning: true,
  });
  models.providers['unconfigured-fixture'] = {
    baseUrl: mock.url,
    api: 'openai-completions',
    models: [{ ...first, id: 'private-only', name: 'Private Only' }],
  };
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
    await expect(modelButton(page)).toHaveText('Mock Model');
    await page.getByRole('button', { name: 'Old model conversation', exact: true }).click();
    await expect(modelButton(page)).toHaveText('Second Model');
    await page.getByRole('button', { name: /New conversation/ }).click();
    await chooseModel(page, 'second-model');
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
    await page.getByRole('button', { name: 'Old model conversation', exact: true }).click();
    await expect(modelButton(page)).toHaveText('Second Model');
    await page.reload();
    await expect(modelButton(page)).toHaveText('Second Model');
    await page.getByRole('textbox', { name: 'Message' }).fill('Use the recent model');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    expect(mock.requests.at(-1)?.model).toBe('second-model');
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('video attachments play in a dialog and workspace references play in the panel', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const video = readFileSync(new URL('../fixtures/preview.webm', import.meta.url));
  writeFileSync(join(paths.cwd, 'clip.webm'), video);
  const service = await startIsolatedHost(paths);
  try {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(service.url + '/#token=' + service.token);
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
    await expect
      .poll(() => playback.evaluate((node: HTMLVideoElement) => node.readyState))
      .toBeGreaterThan(1);
    await media.getByRole('button', { name: 'Close preview' }).click();
    await expect(card).toBeFocused();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Watch @"clip.webm"');
    const reference = page.locator('#prompt').getByRole('button', { name: 'clip.webm', exact: true });
    await reference.click();
    const panel = page.getByRole('dialog', { name: 'Workspace panel' });
    await expect(panel.locator('video[controls]')).toBeVisible();
    await expect(page.locator('.file-media-dialog')).toHaveCount(0);
  } finally {
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
