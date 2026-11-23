import { expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { createFixturePaths } from '../helpers/mock-provider.js';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

export async function startIsolatedHost(paths: ReturnType<typeof createFixturePaths>['paths'], port?: number) {
  const selected = port ?? await availablePort();
  const child: ChildProcess = spawn(process.execPath, [
    resolve('dist/bin/mini-harness.js'), '--no-open', '--cwd', paths.cwd, '--port', String(selected)
  ], {
    env: { ...process.env, MINI_HARNESS_HOME: paths.home },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout?.on('data', (data) => { output += data.toString(); });
  child.stderr?.on('data', (data) => { output += data.toString(); });
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
            if (child.exitCode === null) child.kill('SIGTERM');
            await new Promise<void>((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.once('close', () => resolve());
              setTimeout(resolve, 5000);
            });
          }
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

export async function expectInViewport(panel: ReturnType<Page['locator']>, viewport: { width: number; height: number }) {
  await expect(panel).toBeInViewport({ ratio: 0.99 });
  const bounds = await panel.boundingBox();
  if (!bounds) throw new Error('Expected panel bounding box');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}
