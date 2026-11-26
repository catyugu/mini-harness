import { expect } from '@playwright/test';
import { browserTest as test } from '../support/browser.ts';

test('search, rename, switch conversations and enter bulk selection', async ({ page, launch }) => {
  const { host } = await launch();
  await page.goto(host.url + '/#token=' + host.token);
  const prompt = page.getByRole('textbox', { name: 'Message', exact: true });
  const assistant = page.locator('.message.assistant');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const list = page.locator('.session-name');

  await prompt.fill('Find the violet-sparrow detail');
  await send.click();
  await expect(assistant).toHaveText('Mock response');
  await expect(list).toHaveCSS('font-size', '13px');
  await expect(assistant).toHaveCSS('font-size', '14px');
  const nameBeforeHover = await list.boundingBox();
  await page.locator('.session-row').hover();
  expect(await list.boundingBox()).toEqual(nameBeforeHover);
  await page.getByRole('button', { name: 'Rename Find the violet-sparrow detail' }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Renamed chat');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(list).toHaveText('Renamed chat');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await prompt.fill('Another conversation');
  await send.click();
  await expect(assistant).toHaveText('Mock response');

  const searchToggle = page.getByRole('button', { name: 'Search workspaces and conversations' });
  const search = page.getByRole('searchbox', { name: 'Search workspaces and conversations' });
  await expect(search).toBeHidden();
  await searchToggle.click();
  await expect(search).toBeFocused();
  await search.fill('unmatched term');
  await expect(list).toHaveCount(0);
  await search.fill('violet-sparrow');
  await expect(list).toHaveText('Renamed chat');
  await search.press('Escape');
  await expect(search).toBeHidden();
  await expect(searchToggle).toBeFocused();
  await searchToggle.click();
  await expect(search).toHaveValue('');
  await search.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(list.first()).toHaveCSS('min-height', '44px');
  const select = page.getByRole('button', { name: 'Select conversations' });
  await select.click();
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('checkbox', { name: 'Select Renamed chat', exact: true }).check();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Renamed chat', exact: true }).click();
  await expect(page.locator('.message.user')).toHaveText('Find the violet-sparrow detail');
});
