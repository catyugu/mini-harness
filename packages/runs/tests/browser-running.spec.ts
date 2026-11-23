import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { startIsolatedHost, settingsSection } from '../../../test/support/browser.js';

test('refresh and navigation preserve a run while another conversation completes', async ({ browser }) => {
  for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    let entered: () => void, release: () => void;
    const waiting = new Promise<void>((done) => { entered = done; });
    const held = new Promise<void>((done) => { release = done; });
    const mock = await createMockProvider(async ({ messages }) => {
      if (messages.at(-1).content === 'Keep working') { entered(); await held; return 'Continued after refresh'; }
      return 'Independent reply';
    });
    const { root, paths } = createFixturePaths(mock.url);
    const service = await startIsolatedHost(paths);
    const page = await browser.newPage({ viewport });
    const openSidebar = async () => { if (viewport.width < 860) await page.getByRole('button', { name: 'Toggle navigation' }).click(); };
    try {
      await page.goto(service.url + '/#token=' + service.token);
      await page.getByRole('textbox', { name: 'Message' }).fill('Keep working');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await waiting;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
      await openSidebar();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await settingsSection(page, 'Appearance').click();
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.getByRole('button', { name: 'Close settings' }).click();
      await openSidebar();
      await page.getByRole('button', { name: 'Browse plugins' }).click();
      await page.getByRole('button', { name: 'Subagents settings', exact: true }).click();
      await page.getByLabel('Parallel children · subagents', { exact: true }).fill('2');
      await page.getByRole('button', { name: 'Save configuration' }).click();
      await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
      await openSidebar();
      await page.getByRole('button', { name: /New conversation/ }).click();
      await page.getByRole('textbox', { name: 'Message' }).fill('Second conversation');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.message.assistant')).toHaveText('Independent reply');
      await openSidebar();
      const first = page.getByRole('button', { name: 'Keep working', exact: true });
      const id = (await first.getAttribute('id')).slice('session-'.length);
      let resume: () => void, intercept: () => void;
      const reached = new Promise<void>((done) => { intercept = done; });
      const delayed = new Promise<void>((done) => { resume = done; });
      await page.route('**/api/sessions/' + id, async (route) => {
        intercept();
        await delayed;
        await route.continue().catch(() => { /* A later selection aborts this request. */ });
      }, { times: 1 });
      try {
        await first.click();
        await reached;
        await page.getByRole('button', { name: 'Second conversation', exact: true }).click();
        await expect(page.locator('.message.assistant')).toHaveText('Independent reply');
      } finally { resume(); }
      await openSidebar();
      let disconnected = false;
      await page.route(/\/events\?run=/, (route) => {
        disconnected = true;
        return route.abort();
      }, { times: 1 });
      await first.click();
      await expect.poll(() => disconnected).toBe(true);
      await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
      release();
      await expect(page.locator('.message.assistant')).toHaveText('Continued after refresh');
      await expect(page.locator('.message.user')).toHaveCount(1);
      expect(mock.requests).toHaveLength(2);
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      release(); await page.close(); await service.stop(); await mock.close(); rmSync(root, { recursive: true, force: true });
    }
  }
});
