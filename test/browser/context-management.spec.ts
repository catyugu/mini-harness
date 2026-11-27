import { expect } from '@playwright/test';
import { browserTest as test, readWebProfile, settingsSection } from '../support/browser.ts';

test('context settings update the selected summary model and distinguish conversation overrides', async ({
  page,
  launch,
}) => {
  const { paths, host } = await launch({
    reply: () => ({
      text: 'Measured answer',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }),
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(host.url + '/#token=' + host.token);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'General').click();
  await expect(page.getByRole('switch', { name: 'Auto compaction' })).toHaveCount(0);
  await settingsSection(page, 'Context').click();
  await expect(page.getByRole('heading', { name: 'Context', exact: true })).toBeVisible();
  const global = page.getByRole('dialog', { name: 'Settings', exact: true });
  const trigger = global.getByRole('spinbutton', { name: 'Trigger threshold (%)' });
  const globalAuto = global.getByRole('switch', { name: 'Auto compaction' });
  const globalModel = global.getByRole('button', { name: 'Summary model' });
  await expect(globalModel).toHaveText('Current model');
  const modelBounds = await globalModel.boundingBox();
  const triggerBounds = await trigger.boundingBox();
  expect(modelBounds!.x + modelBounds!.width).toBeCloseTo(triggerBounds!.x + triggerBounds!.width);
  await globalModel.click();
  await global.getByRole('option', { name: /Mock Model/ }).click();
  await expect(globalModel).toHaveText('Mock Model');
  await expect(trigger).toHaveValue('80');
  await trigger.fill('90');
  await globalAuto.uncheck();
  await global.getByRole('button', { name: 'Apply' }).click();
  const restore = global.getByRole('button', { name: 'Restore Default' });
  await expect(restore).toBeEnabled();
  expect(readWebProfile(paths).configuration('context-management')).toMatchObject({
    autoCompact: false,
    triggerRatio: 0.9,
    summaryModel: { provider: 'local-mock', id: 'mock-model' },
  });
  await restore.click();
  await expect(restore).toBeEnabled();
  await expect(trigger).toHaveValue('80');
  await expect(globalAuto).toBeChecked();
  await expect(globalModel).toHaveText('Current model');
  expect(readWebProfile(paths).configuration('context-management')).toMatchObject({
    autoCompact: true,
    triggerRatio: 0.8,
  });
  await page.getByRole('button', { name: 'Close settings' }).click();

  const settings = page.getByRole('button', { name: 'Context settings', exact: true });
  const config = page.getByRole('dialog', { name: 'Context settings' });
  const auto = config.getByRole('switch', { name: 'Auto compaction' });
  await settings.click();
  await expect(auto).toBeChecked();
  const summaryModel = config.getByRole('button', { name: 'Summary model' });
  await expect(summaryModel).toHaveText('Current model');
  await summaryModel.click();
  await config.getByRole('option', { name: /Mock Model/ }).click();
  await expect(summaryModel).toHaveText('Mock Model');
  await expect(config.getByRole('button', { name: 'Compact now' })).toHaveCount(0);
  await auto.uncheck();
  await config.getByRole('button', { name: 'Apply' }).click();
  await expect(auto).toBeEnabled();
  await page.keyboard.press('Escape');

  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Measure the conversation. '.repeat(40));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Measured answer', { exact: true })).toBeVisible();

  const status = page.getByLabel('Conversation statistics');
  await expect(status.getByRole('button', { name: 'Run statistics' })).toContainText('1 turn · 1 step');
  await expect(status.getByRole('button', { name: 'Token usage', exact: true })).toContainText(
    '120 tok · Cache 80%',
  );
  await page.getByRole('button', { name: 'Turn token usage' }).click();
  await expect(page.getByRole('dialog', { name: 'Turn token usage' })).toContainText('80 tok');
  await page.keyboard.press('Escape');

  await page.reload();
  await settings.click();
  await expect(auto).not.toBeChecked();
  await expect(summaryModel).toHaveText('Mock Model');
  await config.getByRole('button', { name: 'Restore Default' }).click();
  await expect(auto).toBeChecked();
  await expect(summaryModel).toHaveText('Current model');
  await page.keyboard.press('Escape');
});
