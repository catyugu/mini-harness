import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.ts';

export function readWebProfile(paths: { home: string }) {
  const yaml = readFileSync(join(paths.home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  const { plugins = [], scopes = {} } = parse(yaml) as {
    plugins?: { id: string; config?: Record<string, unknown> }[];
    scopes?: Record<string, { pluginConfig: Record<string, Record<string, unknown>> }>;
  };
  return { scopes, configuration: (id: string) => plugins.find((item) => item.id === id)?.config };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

export async function startIsolatedHost(
  paths: ReturnType<typeof createFixturePaths>['paths'],
  port?: number,
) {
  const selected = port ?? (await availablePort());
  const child: ChildProcess = spawn(
    process.execPath,
    [resolve('dist/bin/mini-harness.js'), '--no-open', '--cwd', paths.cwd, '--port', String(selected)],
    {
      env: { ...process.env, MINI_HARNESS_HOME: paths.home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  let output = '';
  child.stdout?.on('data', (data) => {
    output += data.toString();
  });
  child.stderr?.on('data', (data) => {
    output += data.toString();
  });
  const pidPath = join(paths.home, 'server.json');
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(pidPath)) {
      const info = JSON.parse(readFileSync(pidPath, 'utf8'));
      const token = /#token=([a-f0-9]{64})/.exec(output)?.[1];
      if (info.pid === child.pid && token) {
        return {
          url: info.url as string,
          token,
          async stop() {
            if (child.exitCode !== null || child.signalCode !== null) return closed;
            const controller = new AbortController();
            const timer = setTimeout(
              () => controller.abort(new Error('mini-harness shutdown timed out')),
              5000,
            );
            try {
              const response = await fetch(info.url + '/api/shutdown', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token },
                signal: controller.signal,
              });
              await response.arrayBuffer();
              if (!response.ok) throw new Error('mini-harness shutdown returned ' + response.status);
              await Promise.race([
                closed,
                new Promise<never>((_, reject) => {
                  if (controller.signal.aborted) reject(controller.signal.reason);
                  else
                    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
                      once: true,
                    });
                }),
              ]);
            } catch (error) {
              if (child.exitCode !== null || child.signalCode !== null) return closed;
              child.kill('SIGTERM');
              await closed;
              throw error;
            } finally {
              clearTimeout(timer);
            }
          },
        };
      }
    }
    if (child.exitCode !== null) throw new Error('mini-harness exited: ' + output);
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill('SIGTERM');
  throw new Error('mini-harness did not start: ' + output);
}

export const settingsSection = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true });
export const modelButton = (page: Page) => page.locator('#modelSelect');
export const modelSearch = (page: Page) => page.getByRole('combobox', { name: 'Search models' });
export const suggestions = (page: Page) => page.getByRole('listbox', { name: 'Input suggestions' });

export async function chooseModel(page: Page, query: string) {
  await modelButton(page).click();
  await modelSearch(page).fill(query);
  await expect(page.getByRole('listbox', { name: 'Configured models' }).getByRole('option')).toHaveCount(1);
  await modelSearch(page).press('Enter');
}

export async function expectInViewport(
  panel: ReturnType<Page['locator']>,
  viewport: { width: number; height: number },
) {
  await expect(panel).toBeInViewport({ ratio: 0.99 });
  const bounds = await panel.boundingBox();
  if (!bounds) throw new Error('Expected panel bounding box');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

type BrowserSetup = {
  reply?: Parameters<typeof createMockProvider>[0];
  prepare?(paths: ReturnType<typeof createFixturePaths>['paths'], root: string): void | Promise<void>;
};

async function launchBrowser({ reply, prepare }: BrowserSetup = {}) {
  const mock = await createMockProvider(reply);
  let directory: string | undefined;
  let host: Awaited<ReturnType<typeof startIsolatedHost>> | undefined;
  const close = async () => {
    try {
      await host?.stop();
    } finally {
      try {
        await mock.close();
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    const { paths, root } = createFixturePaths(mock.url);
    directory = root;
    await prepare?.(paths, root);
    const server = (host = await startIsolatedHost(paths));
    return { mock, paths, root, host: server, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export const browserTest = test.extend<{
  launch: (setup?: BrowserSetup) => Promise<Awaited<ReturnType<typeof launchBrowser>>>;
}>({
  launch: async ({}, use) => {
    const active: Awaited<ReturnType<typeof launchBrowser>>[] = [];
    try {
      await use(async (setup) => {
        const fixture = await launchBrowser(setup);
        active.push(fixture);
        return fixture;
      });
    } finally {
      await Promise.all(active.reverse().map((fixture) => fixture.close()));
    }
  },
});
