import { expectPresent } from '../support/required.ts';
import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.ts';
import { startIsolatedHost, settingsSection } from '../support/browser.ts';
import { join } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/json';

test('refresh and navigation preserve a run while another conversation completes', async ({ browser }) => {
  for (const viewport of [
    { width: 1366, height: 900 },
    { width: 390, height: 844 },
  ]) {
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
    const page = await browser.newPage({ viewport });
    const openSidebar = async () => {
      if (viewport.width < 860) await page.getByRole('button', { name: 'Toggle navigation' }).click();
    };
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
      const id = expectPresent(await first.getAttribute('id'), 'conversation id').slice('session-'.length);
      let resume: () => void = () => {
        throw new Error('Not started');
      };
      let intercept: () => void = () => {
        throw new Error('Not started');
      };
      const reached = new Promise<void>((done) => {
        intercept = done;
      });
      const delayed = new Promise<void>((done) => {
        resume = done;
      });
      await page.route(
        '**/api/sessions/' + id,
        async (route) => {
          intercept();
          await delayed;
          await route.continue().catch(() => {
            /* A later selection aborts this request. */
          });
        },
        { times: 1 },
      );
      try {
        await first.click();
        await reached;
        await page.getByRole('button', { name: 'Second conversation', exact: true }).click();
        await expect(page.locator('.message.assistant')).toHaveText('Independent reply');
      } finally {
        resume();
      }
      await openSidebar();
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
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      release();
      await page.close();
      await service.stop();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('running messages can queue follow-ups and approve shell commands from the GUI', async ({ page }) => {
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
      return { tool: 'sandbox_shell', args: { command: 'echo approved' } };
    return 'Finished';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const config = readJson<any>(paths.settings, {});
  writeJson(paths.settings, {
    ...config,
    plugins: { shell: true },
    pluginConfig: { ...config.pluginConfig, shell: { mode: 'host', timeoutSeconds: 60 } },
  });
  const workspace = join(root, 'Workspace path with spaces ' + 'x'.repeat(100));
  mkdirSync(workspace);
  const service = await startIsolatedHost({ ...paths, cwd: workspace });
  try {
    await page.goto(service.url + '/#token=' + service.token);
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
    await expect(page.getByRole('combobox', { name: 'While running', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel queued message: First instruction' }).click();
    await expect(page.locator('#queuedMessages')).toBeHidden();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Additional instruction');
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(page.locator('#queuedMessages .queue-item > span')).toHaveText(
      'Instruction: Additional instruction',
    );
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'General', exact: true }).click();
    const addInstructions = settings.getByRole('switch', { name: 'Add instructions' });
    await expect(addInstructions).toBeChecked();
    await addInstructions.uncheck();
    await expect(addInstructions).not.toBeChecked();
    await expect(addInstructions).toBeEnabled();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(page.locator('#queuedMessages .queue-item > span')).toHaveText([
      'Instruction: Additional instruction',
      'Follow up: Continue',
    ]);
    release();
    await expect(page.locator('.message.assistant')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(page.locator('#queuedMessages')).toBeHidden();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Shell task');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.approval-card pre')).toHaveText('echo approved');
    await expect(page.locator('.approval-card strong')).toHaveText('Shell approval');
    await expect(page.locator('.approval-heading small')).toHaveText(
      'shell · ' + realpathSync.native(workspace),
    );
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('Missing browser viewport');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeInViewport();
    expect(
      await page.locator('.approval-card').evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.setViewportSize(viewport);
    await expect(page.locator('.tool-state')).toHaveText('Waiting for approval');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(page.locator('.approval-card')).toHaveCount(0);
    await page.getByRole('button', { name: 'Wait', exact: true }).click();
    await expect(page.locator('.approval-card pre')).toHaveText('echo approved');
    const tool = page.locator('.tool-card');
    await tool.locator('summary').click();
    await tool.evaluate((node) => node.setAttribute('data-before-completion', 'true'));
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(tool).toHaveAttribute('open', '');
    await expect(tool).toHaveAttribute('data-before-completion', 'true');
    await expect(page.locator('.approval-card')).toHaveCount(0);
    await expect(page.locator('.tool-arguments')).toContainText('echo approved');
    await expect(page.locator('.tool-content')).toContainText('Exit 0');
    expect(
      await page
        .locator('.tool-content')
        .evaluate((node) =>
          [...node.children].findIndex((child) => child.classList.contains('tool-arguments')),
        ),
    ).toBe(0);
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
    const separator = panel.getByRole('separator');
    await expect(separator).toHaveAttribute('aria-valuenow', '380');
    await separator.press('ArrowLeft');
    await expect(separator).toHaveAttribute('aria-valuenow', '400');
    await expect
      .poll(() => panel.evaluate((node) => Math.round(node.getBoundingClientRect().width)))
      .toBe(400);
    const handle = expectPresent(await separator.boundingBox(), 'panel resize handle');
    await page.mouse.move(handle.x + 3, handle.y + 60);
    await page.mouse.down();
    await page.mouse.move(handle.x - 37, handle.y + 60);
    await expect(separator).toHaveAttribute('aria-valuenow', '440');
    await expect(panel).toHaveCSS('transition-property', 'none');
    await page.mouse.up();
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
    await nav.getByRole('button', { name: 'Collapse workspace workspace', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'nested', exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Search workspaces and conversations' }).click();
    const search = page.getByRole('searchbox', { name: 'Search workspaces and conversations' });
    await search.fill('child workspace');
    await expect(
      nav.getByRole('button', { name: 'Start in the child workspace', exact: true }),
    ).toBeVisible();
    await search.clear();
    await page.reload();
    await expect(nav.getByRole('button', { name: 'nested', exact: true })).toBeHidden();
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
