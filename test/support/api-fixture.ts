import { rmSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { createMiniHarnessServer } from './profile.js';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

export async function waitUntil<T>(read: () => T | Promise<T>, accept: (value: T) => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Timed out waiting for operation');
}

export async function fixture(
  t: TestContext,
  reply?: Parameters<typeof createMockProvider>[0],
  prepare?: (paths: ReturnType<typeof createFixturePaths>['paths']) => void | Promise<void>,
) {
  const mock = await createMockProvider(reply);
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof createMiniHarnessServer>> | undefined;
  t.after(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await mock.close();
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  const { root, paths } = createFixturePaths(mock.url);
  directory = root;
  await prepare?.(paths);
  const server = (app = await createMiniHarnessServer(paths));
  const base = 'http://127.0.0.1:' + (await server.listen(0));
  const headers = { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' };
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const finish = (id: string) =>
    waitUntil(
      () => request('/sessions/' + id + '/runs'),
      ({ body }) => ['completed', 'failed', 'cancelled'].includes(body.run?.state),
    );
  return { mock, paths, root, app: server, request, finish, base, headers };
}
