import { expectPresent } from '../../../test/support/required.js';
import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { startIsolatedHost, settingsSection, modelButton, modelSearch } from '../../../test/support/browser.js';

test('desktop and mobile: send, navigate, settings and bulk select', async ({ browser }) => {
  const mock = await createMockProvider();
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const { root, paths } = createFixturePaths(mock.url);
      const service = await startIsolatedHost(paths);
      const page = await browser.newPage({ viewport });
      const events: string[] = [];
      page.on('pageerror', (error) => events.push(error.message));
      page.on('requestfailed', (req) => events.push(req.url() + ': ' + req.failure()?.errorText));
      try {
        await page.goto(service.url + '/#token=' + service.token);
        const welcome = page.getByRole('heading', { name: 'What are we working on?' });
        await expect(welcome).toBeVisible();
        await expect.poll(() => welcome.evaluate((title) => {
          const composer = expectPresent(document.getElementById('composer'), 'composer');
          return composer.getBoundingClientRect().top - title.getBoundingClientRect().top;
        }), { message: 'Welcome heading stays close to the composer at ' + viewport.width + 'px' }).toBeLessThan(145);
        await expect(modelButton(page)).toHaveText('Mock Model');
        await modelButton(page).click();
        await expect(modelSearch(page)).toBeFocused();
        const modelPop = expectPresent(await page.locator('#modelPicker').boundingBox(), 'model picker bounds');
        expect(modelPop.x).toBeGreaterThanOrEqual(0);
        expect(modelPop.x + modelPop.width).toBeLessThanOrEqual(viewport.width);
        await modelSearch(page).press('Escape');
        await page.getByRole('textbox', { name: 'Message' }).fill('Hello from the browser');
        await page.getByRole('button', { name: 'Send' }).click();
        try {
          await expect(page.locator('.message.assistant')).toHaveText('Mock response', { timeout: 15000 });
        } catch (error) {
          console.error('Browser state:', JSON.stringify({
            viewport, requests: mock.requests.length, events,
            location: page.url(),
            status: await page.locator('#status').textContent().catch(() => null),
            messages: await page.locator('#messages').textContent().catch(() => null)
          }));
          throw error;
        }

        if (viewport.width < 1000) await page.getByRole('button', { name: 'Toggle navigation' }).click();
        await page.getByRole('button', { name: 'Select', exact: true }).click();
        await page.getByRole('checkbox', { name: /Select Hello from the browser/ }).first().check();
        await expect(page.getByText('1 selected')).toBeVisible();
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('button', { name: 'Settings' }).click();
        await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
        await expect(settingsSection(page, 'Plugins')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Manage plugins', exact: true })).toHaveCount(0);
        await settingsSection(page, 'Appearance').click();
        await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Install plugin', exact: true })).toBeHidden();
        await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const dialog = expectPresent(await page.locator('#settingsPanel').boundingBox(), 'settings dialog bounds');
        expect(dialog.x).toBeGreaterThanOrEqual(0);
        expect(dialog.x + dialog.width).toBeLessThanOrEqual(viewport.width);
        if (viewport.width > 560) {
          expect(Math.abs(dialog.x - (viewport.width - dialog.width) / 2)).toBeLessThan(2);
          await page.getByRole('heading', { name: 'Appearance', exact: true }).click();
          await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
          await page.mouse.click(4, 4);
          await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
        } else {
          await expect(settingsSection(page, 'Appearance')).toBeHidden();
          await page.getByRole('button', { name: /All settings/ }).click();
          await expect(settingsSection(page, 'Appearance')).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
        }
      } finally {
        await page.close();
        await service.stop();
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    await mock.close();
  }
});

test('search matches conversation body even after the title changes', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message' }).fill('rarely indexed violet-sparrow detail');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    const id = await page.locator('.session-row .session-name').first().getAttribute('id');
    const sessionId = id?.replace('session-', '');
    expect(sessionId).toBeTruthy();
    await page.request.patch(service.url + '/api/sessions/' + sessionId, {
      headers: { Authorization: 'Bearer ' + service.token },
      data: { title: 'Renamed chat' }
    });
    await page.reload();
    await expect(page.locator('.session-name')).toContainText(['Renamed chat']);
    await page.getByRole('searchbox', { name: 'Search workspaces and conversations' }).fill('violet-sparrow');
    await expect(page.locator('.session-name')).toContainText(['Renamed chat']);
  } finally { await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); }
});
