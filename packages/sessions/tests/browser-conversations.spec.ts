import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { readJson } from '@mini-harness/platform/config';
import { startIsolatedHost, modelSearch, suggestions, expectInViewport } from '../../../test/support/browser.js';

test('drafts, search, rename, single deletion, attachment and input discovery', async ({ page }) => {
  const mock = await createMockProvider(), { root, paths } = createFixturePaths(mock.url);
  const modelsPath = join(paths.home, 'models.json');
  const models = readJson<any>(modelsPath, {});
  models.providers['local-mock'].models[0].input.push('image');
  writeFileSync(modelsPath, JSON.stringify(models));
  writeFileSync(join(paths.cwd, 'notes.md'), '# Notes\nTask details');
  mkdirSync(join(paths.cwd, 'task files'));
  writeFileSync(join(paths.cwd, 'task files', 'draft.md'), '# Draft');
  const skill = join(paths.home, 'skills', 'review'); mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, 'SKILL.md'), '---\nname: review\ndescription: Review the work\n---\n\nReview carefully.');
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    const index = readJson<any>(paths.registry, { sessions: [] }); expect(index.sessions).toHaveLength(0);
    const draft = page.getByRole('textbox', { name: 'Message', exact: true });
    await draft.fill('@');
    await suggestions(page).getByRole('option', { name: 'task files, expand folder' }).click();
    await suggestions(page).getByRole('option', { name: 'draft.md', exact: true }).click();
    await expect(draft).toHaveValue('@"task files/draft.md" ');
    await draft.fill('@');
    await suggestions(page).getByRole('option', { name: 'task files, expand folder' }).click();
    await suggestions(page).getByRole('option', { name: 'Reference task files/', exact: true }).click();
    await expect(draft).toHaveValue('@"task files/" ');
    await draft.fill('@notes');
    await suggestions(page).getByRole('option', { name: 'notes.md', exact: true }).click();
    await expect(draft).toHaveValue('@"notes.md" ');

    await draft.fill('Read this attachment  and keep this text');
    await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(21, 21));
    await draft.press('/'); await draft.press('m'); await draft.press('o');
    await expect(suggestions(page).getByRole('option', { name: /Choose a configured model/ })).toBeVisible();
    await draft.press('Tab');
    await expect(draft).toHaveValue('Read this attachment /model and keep this text');
    await draft.press('Enter');
    await expect(modelSearch(page)).toBeFocused();
    await modelSearch(page).press('Escape');
    await expect(draft).toHaveValue('Read this attachment  and keep this text');

    await draft.fill('Open https://example.test/model and /home/model');
    await expect(suggestions(page)).toBeHidden();
    await draft.fill('Read this attachment  and keep this text');
    await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(21, 21));
    await draft.press('/'); await draft.press('r'); await draft.press('e'); await draft.press('v');
    await expect(suggestions(page).getByRole('option', { name: /Review the work/ })).toBeVisible();
    await draft.press('Enter');
    await expect(draft).toHaveValue('Read this attachment /skill:review and keep this text');
    const images = await page.evaluate(() => [240, 480].map((width) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = width * 7 / 12;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#137';
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png').split(',')[1];
    }));
    await page.locator('#composer input[type=file]').setInputFiles([
      { name: 'task.txt', mimeType: 'text/plain', buffer: Buffer.from('ATTACHED TASK') },
      { name: 'blue.png', mimeType: 'image/png', buffer: Buffer.from(images[0], 'base64') },
      { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(images[1], 'base64') }
    ]);
    await expect(page.getByRole('button', { name: 'Remove task.txt' })).toBeVisible();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    const bubble = page.locator('.message.user').first();
    const thumbs = bubble.locator('.message-images img');
    await expect(thumbs).toHaveCount(2);
    await expect(bubble.getByRole('img', { name: 'blue.png' })).toBeVisible();
    await expect(bubble.getByRole('img', { name: 'reference.png' })).toBeVisible();
    await expect(bubble.getByRole('list', { name: 'Attachments' })).toHaveText('task.txt');
    const desktop = page.viewportSize();
    if (!desktop) throw new Error('Expected a browser viewport');
    const blue = bubble.getByRole('button', { name: 'Preview blue.png' });
    const reference = bubble.getByRole('button', { name: 'Preview reference.png' });
    const preview = page.getByRole('dialog', { name: 'Image preview' });
    await blue.focus();
    await page.keyboard.press('Enter');
    const fullBlue = preview.getByRole('img', { name: 'blue.png' });
    await expect(fullBlue).toHaveCSS('width', '240px');
    await expect(fullBlue).toHaveCSS('height', '140px');
    await page.keyboard.press('Escape');
    await expect(preview).toBeHidden();
    await expect(blue).toBeFocused();
    for (const viewport of [desktop, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      const layout = await bubble.evaluate((node) => {
        const images = [...node.querySelectorAll<HTMLImageElement>('.message-images img')];
        const gallery = images[0].closest('.message-images')!.getBoundingClientRect();
        const last = images.at(-1)!.getBoundingClientRect();
        return { widths: images.map((image) => image.getBoundingClientRect().width),
          offset: Math.abs(gallery.right - last.right), overflow: node.scrollWidth - node.clientWidth };
      });
      expect(layout.widths.every((width) => width >= 56 && width <= 72)).toBe(true);
      expect(layout.offset).toBeLessThan(1);
      expect(layout.overflow).toBeLessThanOrEqual(1);
    }
    await reference.click();
    const fullReference = preview.getByRole('img', { name: 'reference.png' });
    const actualSize = preview.getByRole('button', { name: 'Actual size' });
    await expectInViewport(preview, { width: 320, height: 568 });
    await expect(actualSize).toHaveAttribute('aria-pressed', 'false');
    const fitted = (await fullReference.boundingBox())!;
    expect(fitted.width).toBeLessThan(320);
    expect(fitted.width / fitted.height).toBeCloseTo(12 / 7, 2);
    await actualSize.click();
    await expect(fullReference).toHaveCSS('width', '480px');
    await expect(fullReference).toHaveCSS('height', '280px');
    await expect(preview.getByRole('region', { name: 'Image', exact: true })).toHaveJSProperty('scrollWidth', 480);
    await preview.getByRole('button', { name: 'Close image preview' }).click();
    await expect(preview).toBeHidden();
    await page.setViewportSize(desktop);
    expect(JSON.stringify(mock.requests[0])).toContain('image_url');
    expect(JSON.stringify(mock.requests[0])).toContain('ATTACHED TASK');
    expect(JSON.stringify(mock.requests[0])).toContain('Review carefully.');
    expect(JSON.stringify(mock.requests[0])).toContain('Read this attachment and keep this text');
    await draft.fill('/export');
    const exported = page.waitForEvent('download');
    await draft.press('Enter');
    expect((await exported).suggestedFilename()).toBe('mini-harness-sessions.json');
    await expect(page.locator('.attachment')).toHaveCount(0);
    await page.locator('.session-row').hover();
    await page.getByRole('button', { name: /^Rename .*Read this attachment|^Rename \/skill:review/ }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Project review');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.locator('#conversationTitle')).toHaveText('Project review');
    await draft.fill('Keep this draft');
    await page.evaluate(() => {
      const read = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function (file) {
        window.setTimeout(() => read.call(this, file), 700);
      };
    });
    await page.locator('#composer input[type=file]').setInputFiles({ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('ONLY FOR PROJECT REVIEW') });
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(draft).toHaveValue('');
    await draft.fill('Different conversation');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    expect(JSON.stringify(mock.requests.at(-1))).not.toContain('ONLY FOR PROJECT REVIEW');
    await page.getByRole('button', { name: 'Project review', exact: true }).click();
    await expect(draft).toHaveValue('Keep this draft');
    await expect(page.getByRole('button', { name: 'Remove private.txt' })).toBeVisible();
    await page.locator('.session-row').filter({ hasText: 'Different conversation' }).hover();
    await page.getByRole('button', { name: 'Delete Different conversation', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete conversation' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Search workspaces and conversations' }).click();
    await page.getByRole('searchbox', { name: 'Search workspaces and conversations' }).fill('absent');
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search workspaces and conversations' }).fill('review');
    await expect(page.locator('#sessions .session-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Delete Project review', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Delete conversation' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('#sessions .session-row')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
