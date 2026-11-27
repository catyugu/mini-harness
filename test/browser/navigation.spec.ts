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
  await expect(list).toHaveText('Find the violet-sparrow detail');
  await expect(list).toBeVisible();
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

test('desktop navigation resizes within bounds and remembers its width', async ({ page, launch }) => {
  const { host } = await launch();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(host.url + '/#token=' + host.token);
  const sidebar = page.locator('#sidebar');
  const handle = page.locator('#sidebarResize');
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  await expect(sidebar).toHaveCSS('width', '340px');
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error('Missing navigation separator');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 150, bounds.y + bounds.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(sidebar).toHaveCSS('width', '280px');
  await handle.press('ArrowRight');
  await expect(sidebar).toHaveCSS('width', '300px');
  const updated = await handle.boundingBox();
  if (!updated) throw new Error('Missing navigation separator');
  await page.mouse.move(updated.x + updated.width / 2, updated.y + updated.height / 2);
  await page.mouse.down();
  await page.mouse.move(updated.x + 160, updated.y + updated.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(sidebar).toHaveCSS('width', '380px');
  await toggle.click();
  await expect(sidebar).toHaveCSS('width', '56px');
  await expect(handle).toBeHidden();
  await toggle.click();
  await expect(sidebar).toHaveCSS('width', '380px');

  await page.reload();
  await expect(sidebar).toHaveCSS('width', '380px');
  const panel = page.locator('#inspector');
  const panelHandle = page.getByRole('separator', { name: 'Resize workspace panel' });
  const open = page.getByRole('button', { name: 'Open workspace panel' });
  await open.click();
  await expect(sidebar).toHaveCSS('width', '380px');
  await panelHandle.press('ArrowLeft');
  await expect(panel).toHaveCSS('width', '400px');
  await page.setViewportSize({ width: 1220, height: 900 });
  await expect(sidebar).toHaveCSS('width', '380px');
  await expect(panel).toHaveCSS('width', '320px');
  await page.setViewportSize({ width: 900, height: 900 });
  const drawer = page.getByRole('dialog', { name: 'Workspace panel' });
  await expect(drawer).toBeVisible();
  await expect(sidebar).toHaveCSS('width', '380px');
  await expect(panelHandle).toBeHidden();
  await expect(drawer.getByRole('button', { name: 'Close workspace panel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
  await open.click();
  await expect(drawer).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(panel).toHaveCSS('width', '400px');
  await expect(panelHandle).toBeVisible();
  await toggle.click();
  await expect(sidebar).toHaveCSS('width', '56px');
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(panelHandle).toBeVisible();
  await toggle.click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Close workspace panel' }).click();
  await expect(sidebar).toHaveCSS('width', '380px');
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 900 });
  await open.click();
  await expect(panel).toHaveCSS('width', '400px');
  await panel.getByRole('button', { name: 'Close workspace panel' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.click();
  await expect(sidebar).toHaveCSS('width', '300px');
  await expect(handle).toBeHidden();
  await page
    .getByRole('dialog', { name: 'Conversations' })
    .getByRole('button', { name: 'Close navigation', exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(sidebar).toHaveCSS('width', '380px');
});

test('first frame already uses the correct layout at the mobile boundary', async ({ page, launch }) => {
  const { host } = await launch();
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const root = document.getElementById('app');
      if (!root) return;
      observer.disconnect();
      requestAnimationFrame(() => {
        const sidebar = document.getElementById('sidebar')!;
        const resize = document.getElementById('sidebarResize')!;
        document.documentElement.dataset.firstLayout = [
          getComputedStyle(sidebar).position,
          resize.hidden,
          sidebar.inert,
          getComputedStyle(sidebar).width,
        ].join(':');
      });
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  for (const width of [860, 861]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(host.url + '/#token=' + host.token);
    await expect(page.locator('html')).toHaveAttribute(
      'data-first-layout',
      width === 860 ? 'fixed:true:true:300px' : 'relative:false:false:340px',
    );
  }
  await page.setViewportSize({ width: 860, height: 900 });
  await expect(page.locator('#sidebarResize')).toBeHidden();
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Conversations' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeFocused();
  await page.setViewportSize({ width: 861, height: 900 });
  await expect(page.getByRole('separator', { name: 'Resize navigation sidebar' })).toBeVisible();
});
