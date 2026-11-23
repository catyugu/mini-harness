

import { rmSync } from 'node:fs';

import { createMiniHarnessServer } from '#mini-harness/host/server.js';

import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

export const waitUntil = async <T>(read: () => T | Promise<T>, accept: (value: T) => boolean) => {
  for (let i = 0; i < 300; i++) { const value = await read(); if (accept(value)) return value; await new Promise((done) => setTimeout(done, 10)); }
  throw new Error('Timed out waiting for operation');
};
export async function fixture(t: any, reply?: Parameters<typeof createMockProvider>[0]) {
  const mock = await createMockProvider(reply), { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths), base = 'http://127.0.0.1:' + await app.listen(0);
  t.after(async () => { await app.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  const request = async (path: string, method = 'GET', body?: any, extra = {}) => {
    const response = await fetch(base + '/api' + path, { method, headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const finish = (id: string) => waitUntil(() => request('/sessions/' + id + '/runs'), (r) => ['completed', 'failed', 'cancelled'].includes(r.body.run?.state));
  return { mock, paths, root, app, request, finish, base };
}

