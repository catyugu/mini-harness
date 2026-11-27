import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../support/mock-provider.ts';
import { writePlugin } from '../support/plugin-fixture.ts';
import { startIsolatedHost } from '../support/browser.ts';
import { join } from 'node:path';
import { writeJson } from '@mini-harness/platform/json';

test('refresh and navigation preserve a run while another conversation completes', async ({ page }) => {
  let entered: () => void = () => {
    throw new Error('Not started');
  };
  let release: () => void = () => {
    throw new Error('Not started');
  };
  const waiting = new Promise<void>((done) => {
    entered = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  const mock = await createMockProvider(async ({ messages }) => {
    if (messages.at(-1)?.content === 'Keep working') {
      entered();
      await held;
      return 'Continued after refresh';
    }
    return 'Independent reply';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message' }).fill('Keep working');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waiting;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    await page.getByRole('button', { name: /New conversation/ }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Second conversation');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Independent reply');
    const first = page.getByRole('button', { name: 'Keep working', exact: true });
    let disconnected = false;
    await page.route(
      /\/events\?run=/,
      (route) => {
        disconnected = true;
        return route.abort();
      },
      { times: 1 },
    );
    await first.click();
    await expect.poll(() => disconnected).toBe(true);
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    release();
    await expect(page.locator('.message.assistant')).toHaveText('Continued after refresh');
    await expect(page.locator('.message.user')).toHaveCount(1);
    expect(mock.requests).toHaveLength(2);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  } finally {
    release();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('running messages can queue follow-ups and run shell commands from the GUI', async ({ page }) => {
  let release: () => void = () => {
    throw new Error('Not started');
  };
  let entered: () => void = () => {
    throw new Error('Not started');
  };
  const held = new Promise<void>((done) => {
      release = done;
    }),
    waiting = new Promise<void>((done) => {
      entered = done;
    });
  const mock = await createMockProvider(async ({ messages }) => {
    if (messages.at(-1)?.content === 'Wait') {
      entered();
      await held;
      return 'First reply';
    }
    if (messages.at(-1)?.content === 'Shell task')
      return { tool: 'shell', args: { command: 'echo approved' } };
    return 'Finished';
  });
  const { root, paths } = createFixturePaths(mock.url);
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [{ id: 'shell', disabled: false, config: { timeoutMs: 60000, maxOutputBytes: 64000 } }],
  });
  const workspace = join(root, 'Workspace path with spaces ' + 'x'.repeat(100));
  mkdirSync(workspace);
  const service = await startIsolatedHost({ ...paths, cwd: workspace });
  try {
    await page.goto(service.url + '/#token=' + service.token);
    const mode = page.getByRole('combobox', { name: 'Message sending mode', exact: true });
    await expect(mode).toBeHidden();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Wait');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waiting;
    await page.getByRole('button', { name: 'Permissions: Standard' }).click();
    await expect(
      page.getByRole('listbox', { name: 'Conversation permissions' }).getByRole('option'),
    ).toHaveText([/Full access/, /Standard/, /Read-only/]);
    await page.getByRole('option', { name: /Read-only/ }).click();
    await expect(page.getByRole('button', { name: 'Permissions: Read-only' })).toBeVisible();
    await page.getByRole('button', { name: 'Permissions: Read-only' }).click();
    await page.getByRole('option', { name: /Standard/ }).click();
    await expect(page.getByRole('button', { name: 'Permissions: Standard' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('First instruction');
    await expect(mode).toBeVisible();
    await expect(mode).toHaveValue('interrupt');
    await mode.selectOption('steer');
    await page.getByRole('button', { name: 'Send with Steer', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel queued message: First instruction' }).click();
    await expect(page.locator('#queuedMessages')).toBeHidden();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Additional instruction');
    await page.getByRole('button', { name: 'Send with Steer', exact: true }).click();
    await expect(page.locator('#queuedMessages .queue-item > span')).toHaveText(
      'Steer · Additional instruction',
    );
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'General', exact: true }).click();
    const defaultSendingMode = settings.getByRole('combobox', { name: 'Default sending mode' });
    await expect(defaultSendingMode).toHaveValue('interrupt');
    await defaultSendingMode.selectOption('queue');
    await expect(defaultSendingMode).toHaveValue('queue');
    await expect(defaultSendingMode).toBeEnabled();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(mode).toHaveValue('steer');
    await mode.selectOption('queue');
    await page.getByRole('button', { name: 'Send with Queue', exact: true }).click();
    await expect(page.locator('#queuedMessages .queue-item > span')).toHaveText([
      'Steer · Additional instruction',
      'Queue · Continue',
    ]);
    release();
    await expect(page.locator('.message.assistant')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.locator('#queuedMessages')).toBeHidden();
    await expect(mode).toBeHidden();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Shell task');
    const normalSend = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/runs'),
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    expect((await normalSend).postDataJSON()).not.toHaveProperty('mode');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.locator('.approval-card')).toHaveCount(0);
    const tool = page.locator('.tool-card');
    await tool.locator('summary').click();
    await expect(page.locator('.tool-arguments')).toContainText('echo approved');
    await expect(page.locator('.tool-content')).toContainText('Exit 0');
    await expect(page.locator('.tool-duration')).toHaveText(/\d+ (ms|s)/);
    await expect(page.locator('.tool-exit-code')).toHaveText('Exit 0');
    await expect(page.locator('#runSummary')).toContainText('Completed');
    await page.getByRole('button', { name: 'Permissions: Standard' }).click();
    await page.getByRole('option', { name: /Read-only/ }).click();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Permissions: Standard' })).toBeVisible();
    await page.getByRole('button', { name: 'Wait', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Permissions: Read-only' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Permissions: Read-only' })).toBeVisible();
    await expect(page.locator('.tool-exit-code')).toHaveText('Exit 0');
    await expect(page.locator('.tool-duration')).toHaveText(/\d+ (ms|s)/);
  } finally {
    release();
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('switching workspaces preserves running conversations and each workspace’s file tabs', async ({
  page,
}) => {
  let entered: () => void = () => {
    throw new Error('Not started');
  };
  let release: () => void = () => {
    throw new Error('Not started');
  };
  const waiting = new Promise<void>((done) => {
    entered = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  const mock = await createMockProvider(async ({ messages }) => {
    if (messages.at(-1)?.content === 'Keep working here') {
      entered();
      await held;
      return 'First workspace finished';
    }
    return 'Second workspace finished';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const second = join(paths.cwd, 'nested');
  mkdirSync(second);
  for (const [directory, text] of [
    [paths.cwd, 'first'],
    [second, 'second'],
  ]) {
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src', 'common.ts'), 'const workspace = "' + text + '";');
  }
  const service = await startIsolatedHost(paths);
  try {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(service.url + '/#token=' + service.token);
    const nav = page.getByRole('navigation', { name: 'Conversation tree' });
    const prompt = page.getByRole('textbox', { name: 'Message', exact: true });
    const panel = page.getByRole('complementary', { name: 'Workspace panel' });
    const open = page.getByRole('button', { name: 'Open workspace panel', exact: true });
    const close = () => panel.getByRole('button', { name: 'Close workspace panel' }).click();
    await prompt.fill('Keep working here');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waiting;
    await expect(nav.getByRole('button', { name: 'Keep working here', exact: true })).toBeVisible();
    await open.click();
    await panel.getByRole('button', { name: /Workspace files/ }).click();
    await panel.locator('summary').filter({ hasText: /^src$/ }).click();
    await panel.getByRole('button', { name: 'common.ts', exact: true }).click();
    await expect(panel.locator('.syntax-string')).toHaveText('"first"');
    await expect(panel.locator('.source-line')).toHaveAttribute('data-line', '1');
    await close();
    await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add workspace' });
    await picker.getByLabel('Absolute directory path').fill(second);
    await picker.getByRole('button', { name: 'Add workspace', exact: true }).click();
    await nav.getByRole('button', { name: 'New in nested', exact: true }).click();
    await prompt.fill('Start in the child workspace');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Second workspace finished');
    await open.click();
    await panel.getByRole('button', { name: /Workspace files/ }).click();
    await panel.locator('summary').filter({ hasText: /^src$/ }).click();
    await panel.getByRole('button', { name: 'common.ts', exact: true }).click();
    await expect(panel.locator('.syntax-string')).toHaveText('"second"');
    await close();
    await nav.getByRole('button', { name: 'Keep working here', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    await open.click();
    await expect(panel.getByRole('tab', { name: 'common.ts', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(panel.locator('.syntax-string')).toHaveText('"first"');
    await panel.getByRole('tab', { name: 'Files', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'common.ts', exact: true })).toBeVisible();
    await close();
    release();
    await expect(page.locator('.message.assistant')).toHaveText('First workspace finished');
  } finally {
    release();
    await page.close();
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the browser starts with authenticated requests and recovers when credentials are replaced', async ({
  page,
}) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const host = await startIsolatedHost(paths);
  try {
    await page.goto(host.url + '/#token=' + host.token);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    const seen: Record<string, string>[] = [];
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      seen.push(route.request().headers());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate(async () => {
      const { api } = (await import(String('/packages/ui-runtime/src/browser/http.js'))) as {
        api: (path: string, options: RequestInit) => Promise<Response>;
      };
      await api('/settings', {
        method: 'PATCH',
        headers: new Headers({
          'X-Plugin-Request': 'present',
          'Content-Type': 'application/merge-patch+json',
          Authorization: 'Bearer stale',
        }),
        body: '{}',
      });
    });
    expect(seen.at(-1)?.['x-plugin-request']).toBe('present');
    expect(seen.at(-1)?.['content-type']).toBe('application/merge-patch+json');
    expect(seen.at(-1)?.authorization).toBe('Bearer ' + host.token);
    await page.unroute('**/api/settings');
    // A hash-only navigation to the same page used to leave ESM state and the old token intact.
    await page.evaluate(() => {
      location.hash = 'token=invalid-credential';
    });
    await expect(page.locator('#startupStatus')).toContainText('Session authorization expired');
    await page.evaluate((token) => {
      location.hash = 'token=' + token;
    }, host.token);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expect(page.locator('#startupStatus')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('mini-harness-token'))).toBe(host.token);
  } finally {
    await host.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an already open tab reconnects to the same instance after restart', async ({ page }) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  let host = await startIsolatedHost(paths);
  try {
    await page.goto(host.url + '/#token=' + host.token);
    const composer = page.getByRole('textbox', { name: 'Message' });
    await expect(composer).toBeVisible();
    await composer.fill('Before restart');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveText('Mock response');
    const { url, token } = host;
    await host.stop();
    host = await startIsolatedHost(paths, Number(new URL(url).port));
    expect(host.token).toBe(token);
    await composer.fill('After restart');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    await expect(page.locator('#startupStatus')).toBeHidden();
  } finally {
    await page.close();
    await host.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('mobile background tasks and subagents use independent popovers', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await createMockProvider(({ messages }) => {
    if (messages.at(-1)?.content === 'Start independent job')
      return { tool: 'start_background', args: { tool: 'fixture_background', arguments: {} } };
    if (messages.at(-1)?.content === 'Start child')
      return { tool: 'delegate', args: { task: 'Child fixture' } };
    return 'Acknowledged';
  });
  const { root, paths } = createFixturePaths(mock.url);
  writePlugin(
    paths.plugins,
    'background-fixture',
    {},
    `
export const inject = ['harnessTools'];
export const apply = (ctx) => {
  ctx.effect(() => ctx.harnessTools.register({
    name: 'fixture_background',
    label: 'Fixture job',
    description: 'Produce output and wait for cancellation',
    background: true,
    parameters: { type: 'object' },
    async execute(_, { signal, write }) {
      write('Task output is visible');
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  }));
};
`,
  );
  writeJson(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), {
    plugins: [{ id: 'background-fixture', name: '../../plugins/background-fixture' }],
  });
  const service = await startIsolatedHost(paths);
  try {
    await page.goto(service.url + '/#token=' + service.token);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Start independent job');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.tool-card .tool-state')).toHaveText('Accepted');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Message sending mode' })).toBeHidden();
    const tasks = page.locator('.background-tasks');
    const toggle = tasks.getByRole('button', { name: 'Tasks', exact: true });
    const agents = page.locator('.subagent-tasks');
    const agentToggle = agents.getByRole('button', { name: 'Subagents', exact: true });
    await toggle.click();
    const panel = tasks.locator('.background-task-list');
    const row = panel.getByRole('button', { name: 'Fixture job · Running', exact: true });
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.locator('.task-output')).toHaveCount(0);
    await row.click();
    await expect(panel.locator('.task-output')).toHaveText('Task output is visible');
    await panel.getByRole('button', { name: 'Cancel Fixture job', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Fixture job · Cancelled', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Finished 1', exact: true })).toBeVisible();
    await toggle.click();
    const notification = page
      .locator('details.async-message')
      .filter({ hasText: 'Background task finished' });
    await expect(notification.locator('summary')).toBeVisible();
    await expect(notification).not.toHaveAttribute('open', '');
    await expect(notification.locator('article')).toBeHidden();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Start child');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(agentToggle).toHaveText('1 subagent');
    await expect(toggle).toHaveText('1 task');

    await agentToggle.click();
    const agentPanel = agents.locator('.subagent-list');
    await expect(
      agentPanel.getByRole('button', { name: 'Open conversation: Child fixture', exact: true }),
    ).toBeVisible();
    await expect(agentPanel.locator('.task-output')).toHaveCount(0);
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(agentPanel).toBeHidden();
    await expect(panel.getByRole('button', { name: 'Fixture job · Cancelled', exact: true })).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Open conversation: Child fixture', exact: true }),
    ).toHaveCount(0);
    await panel.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(toggle).toBeHidden();
    await expect(agentToggle).toHaveText('1 subagent');
  } finally {
    await service.stop();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
