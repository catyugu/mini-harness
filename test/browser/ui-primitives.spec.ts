import { expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '@mini-harness/platform/json';
import { browserTest as test } from '../support/browser.ts';

test('overflow preserves controls and follows an anchor moved by container layout', async ({
  page,
  launch,
}) => {
  const { host } = await launch({
    prepare(paths) {
      const folder = join(paths.plugins, 'primitive-fixture');
      mkdirSync(folder);
      writeJson(join(folder, 'plugin.json'), {});
      writeFileSync(
        join(folder, 'web.js'),
        `
export const inject = ['miniPrimitives'];
export function apply(ctx) {
  const { miniPrimitives: ui } = ctx;
  const signal = ctx.fiber.signal;
  const area = document.createElement('section');
  area.setAttribute('aria-label', 'Action fixture');
  area.style.cssText = 'position:fixed;top:50px;left:16px;width:560px;z-index:5';
  const draft = document.createElement('input');
  draft.style.width = '100%';
  draft.size = 16;
  draft.setAttribute('aria-label', 'Draft');
  const nested = ui.button('Open details');
  const panel = document.createElement('div');
  panel.popover = 'auto';
  panel.className = 'ui-popover';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Details');
  const dismiss = ui.button('Detail action');
  dismiss.autofocus = true;
  const content = document.createElement('div');
  content.textContent = 'Expanded details';
  content.style.height = '48px';
  content.hidden = true;
  dismiss.onclick = () => content.hidden = !content.hidden;
  panel.append(dismiss, content);
  const details = document.createElement('div');
  details.append(nested, panel);
  nested.onclick = ui.bindPopover(nested, panel, signal, { prefer: 'above' });
  ctx.effect(() => {
    document.body.append(area);
    return () => area.remove();
  });
  ui.overflowActions(area, 'More actions', signal)([ui.button('A'), draft, details]);
}
`,
      );
      writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
        plugins: [{ id: 'primitive-fixture', name: '../../plugins/primitive-fixture', client: true }],
      });
    },
  });
  await page.goto(host.url + '/#token=' + host.token);
  const area = page.getByRole('region', { name: 'Action fixture' });
  const draft = page.getByRole('textbox', { name: 'Draft' });
  const more = page.getByRole('button', { name: 'More actions' });
  await draft.fill('Unsaved input');
  await area.evaluate((node) => (node.style.width = '145px'));
  await expect(more).toBeFocused();
  await more.click();
  const overflow = page.getByRole('region', { name: 'More actions' });
  const draftWidth = (await draft.boundingBox())!.width;
  await overflow.evaluate(async (node) => {
    node.style.width = '74px';
    for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
  });
  await expect(overflow.getByRole('textbox', { name: 'Draft' })).toHaveValue('Unsaved input');
  expect((await draft.boundingBox())?.width).toBe(draftWidth);
  await overflow.evaluate((node) => node.style.removeProperty('width'));
  const details = page.getByRole('button', { name: 'Open details' });
  await details.click();
  const action = page.getByRole('button', { name: 'Detail action' });
  await expect(action).toBeFocused();
  const initial = (await action.boundingBox())!.y;
  await area.evaluate((node) => (node.style.top = '100px'));
  await expect.poll(async () => (await action.boundingBox())?.y ?? 0).toBeGreaterThan(initial + 30);
  const floating = page.getByRole('region', { name: 'Details', exact: true });
  const before = (await floating.boundingBox())!;
  const bottom = async () => {
    const box = (await floating.boundingBox())!;
    return box.y + box.height;
  };
  await action.click();
  await expect(floating.getByText('Expanded details')).toBeVisible();
  await expect.poll(bottom).toBeCloseTo(before.y + before.height, 0);
  await action.click();
  await expect(floating.getByText('Expanded details')).toBeHidden();
  await expect.poll(bottom).toBeCloseTo(before.y + before.height, 0);
  await page.keyboard.press('Escape');
  await expect(details).toBeFocused();
  const anchor = overflow.locator('button', { hasText: 'Open details' });
  for (const blockedBy of ['inert', 'visibility']) {
    await details.click();
    await expect(action).toBeFocused();
    await anchor.evaluate((node, reason) => {
      if (reason === 'inert') node.setAttribute('inert', '');
      else node.style.visibility = 'hidden';
    }, blockedBy);
    await expect(action).toBeHidden();
    await anchor.evaluate((node) => {
      node.removeAttribute('inert');
      node.style.removeProperty('visibility');
    });
  }
  await details.focus();
  await area.evaluate((node) => (node.style.width = '560px'));
  await expect(more).toBeHidden();
  await expect(details).toBeFocused();
  await expect(draft).toHaveValue('Unsaved input');
});
