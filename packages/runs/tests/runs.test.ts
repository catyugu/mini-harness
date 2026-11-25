import { expectPresent } from '../../../test/support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createMiniHarnessServer } from '../../../test/support/profile.ts';
import { SessionRegistry } from '@mini-harness/sessions/registry';
import { WorkspaceCatalog } from '@mini-harness/workspaces/catalog';
import type { RunEvent } from '../src/stream.ts';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.ts';

function gate() {
  let release: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release: () => release() };
}

test(
  'HTTP disconnect keeps the native run alive and reconnect replays from a cursor',
  { timeout: 15000 },
  async (t) => {
    const entered = gate(),
      held = gate();
    const mock = await createMockProvider(async () => {
      entered.release();
      await held.promise;
      return 'Reconnected response';
    });
    const { root, paths } = createFixturePaths(mock.url);
    const app = await createMiniHarnessServer(paths);
    t.after(async () => {
      held.release();
      await app.close();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    });
    const port = await app.listen(0);
    const base = 'http://127.0.0.1:' + port;
    const headers = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
    const item = app.runtime.plugins.ctx.harnessSessions.create();
    const controller = new AbortController();
    const start = await fetch(base + '/api/sessions/' + item.id + '/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Keep working' }),
    });
    assert.equal(start.status, 202);
    const { id: runId } = await start.json();
    const response = await fetch(base + '/api/sessions/' + item.id + '/events?run=' + runId, {
      headers,
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    await entered.promise;
    assert.ok(response.body);
    const reader = response.body.getReader();
    const first = new TextDecoder()
      .decode((await reader.read()).value)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const firstEvent = first.at(-1);
    assert.ok(firstEvent);
    const cursor = firstEvent.sequence;
    controller.abort();
    await reader.cancel().catch(() => {});
    assert.equal(app.runtime.plugins.ctx.harnessRuns.active(item.id), true);
    const status = await (await fetch(base + '/api/sessions/' + item.id + '/runs', { headers })).json();
    assert.equal(status.run.state, 'running');
    const runs = app.runtime.plugins.ctx.harnessRuns;
    const pending = runs.completion(item.id);
    const observed: RunEvent[] = [];
    const detach = runs.watch(item.id, runId, status.run.sequence, (event) => observed.push(event));
    const record = app.runtime.plugins.ctx.harnessSessions.log(item.id).append({
      type: 'plugin-record',
      owner: { pluginId: 'fixture', instanceId: 'fixture' },
      data: 'private record',
    });
    const branch = observed.find((event) => event.type === 'branch');
    assert.equal(branch?.leafId, record.id);
    assert.deepEqual(branch?.records, []);
    detach();
    const replay = fetch(
      base + '/api/sessions/' + item.id + '/events?run=' + status.run.id + '&after=' + cursor,
      { headers },
    );
    held.release();
    await pending;
    const events = (await (await replay).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(events.every((event) => event.sequence > cursor));
    assert.ok(events.some((event) => event.type === 'complete' || event.type === 'snapshot'));
    const finishedRun = app.runtime.plugins.ctx.harnessRuns.info(item.id);
    assert.ok(finishedRun);
    assert.equal(finishedRun.state, 'completed');
    const durable = readFileSync(app.runtime.plugins.ctx.harnessSessions.log(item.id).file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const persistedRun = durable.filter((entry) => entry.type === 'run').at(-1);
    assert.ok(persistedRun);
    assert.equal(persistedRun.run.state, 'completed');
  },
);

test(
  'independent roots run concurrently and deleting a running tree cancels all descendants',
  { timeout: 15000 },
  async (t) => {
    const held = gate();
    const entered = gate();
    let requests = 0;
    const mock = await createMockProvider(async () => {
      if (++requests === 2) entered.release();
      await held.promise;
      return 'Done';
    });
    const { root, paths } = createFixturePaths(mock.url);
    const app = await createMiniHarnessServer(paths);
    t.after(async () => {
      held.release();
      await app.close();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    });
    const parent = app.runtime.plugins.ctx.harnessSessions.create(),
      other = app.runtime.plugins.ctx.harnessSessions.create();
    const first = app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Root one');
    const cancelled = assert.rejects(first, /cancelled/);
    const second = app.runtime.plugins.ctx.harnessRuns.send(other.id, 'Root two');
    await entered.promise;
    assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 2);
    await assert.rejects(app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Duplicate'), /already running/);
    const child = app.runtime.plugins.ctx.harnessSessions.create({ parentId: parent.id });
    const childWork = app.runtime.plugins.ctx.harnessRuns.send(child.id, 'Child');
    const childCancelled = assert.rejects(childWork, /cancelled/);
    const deleted = await app.runtime.plugins.ctx.harnessSessions.delete([parent.id]);
    await Promise.all([cancelled, childCancelled]);
    assert.deepEqual(new Set(deleted), new Set([parent.id, child.id]));
    assert.equal(app.runtime.plugins.ctx.harnessSessions.get(parent.id), undefined);
    assert.equal(app.runtime.plugins.ctx.harnessRuns.active(other.id), true);
    held.release();
    assert.equal(await second, 'Done');
    assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 0);
    assert.equal(app.runtime.plugins.ctx.harnessRuns.size, 0);
  },
);

test('startup durably interrupts runs, fails stale steering, and recovers idempotently', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  t.after(async () => {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const registry = new SessionRegistry(paths, new WorkspaceCatalog(paths));
  const parent = registry.create(),
    child = registry.create({ parentId: parent.id });
  registry.log(child.id).append({
    type: 'run',
    run: {
      id: 'fixture-run',
      sessionId: child.id,
      state: 'running',
      startedAt: new Date().toISOString(),
      sequence: 1,
    },
  });
  registry.log(child.id).append({
    type: 'inbox-enqueued',
    item: { id: 'steer', mode: 'steer', text: 'Old instruction', images: [] },
  });
  registry.log(child.id).append({
    type: 'inbox-enqueued',
    item: { id: 'follow', mode: 'followUp', text: 'Recovered follow-up', images: [] },
  });
  const file = registry.log(child.id).file;
  registry.dispose();
  const restored = new SessionRegistry(paths, new WorkspaceCatalog(paths));
  t.after(() => restored.dispose());
  const interrupted = restored.runSummary(child.id);
  assert.ok(interrupted);
  assert.equal(interrupted.state, 'interrupted');
  assert.deepEqual(restored.descendants([parent.id]), [parent.id, child.id]);
  const bytes = readFileSync(file);
  assert.match(bytes.toString(), /"state":"interrupted"/);
  assert.deepEqual(
    restored.inspectLog(child.id, (log) => log.queue().map(({ id, state }) => [id, state])),
    [
      ['follow', 'pending'],
      ['steer', 'failed'],
    ],
  );
  assert.equal(restored.inspectLog(parent.id, (log) => log.entries()) !== undefined, false);
  assert.doesNotMatch(readFileSync(paths.registry, 'utf8'), /lastRuns|fixture-run/);
  restored.dispose();
  const restarted = await createMiniHarnessServer(paths);
  try {
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(
      await restarted.runtime.plugins.ctx.harnessRuns.send(child.id, 'New manual input'),
      'Mock response',
    );
    const prompts = mock.requests.map(({ messages }) => {
      const content = (messages as { role: string; content: string | { text: string }[] }[]).at(-1)?.content;
      return Array.isArray(content) ? content.map(({ text }) => text).join('') : content;
    });
    assert.deepEqual(prompts, ['Recovered follow-up', 'New manual input']);
    assert.deepEqual(
      restarted.runtime.plugins.ctx.harnessSessions
        .log(child.id)
        .queue()
        .map(({ id, state }) => [id, state]),
      [['steer', 'failed']],
    );
  } finally {
    await restarted.close();
  }
});

test('late observers receive a saved snapshot and stale cursors cannot attach to a newer run', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const item = app.runtime.plugins.ctx.harnessSessions.create();
  await app.runtime.plugins.ctx.harnessRuns.send(item.id, 'First');
  const first = app.runtime.plugins.ctx.harnessRuns.info(item.id);
  const events: RunEvent[] = [];
  assert.ok(first);
  app.runtime.plugins.ctx.harnessRuns.watch(item.id, first.id, 0, (event) => events.push(event));
  assert.equal(events.length, 1);
  assert.ok(events[0]);
  assert.equal(events[0].type, 'snapshot');
  assert.ok(events[0].type === 'snapshot' && events[0].messages.some(({ role }) => role === 'assistant'));
  await app.runtime.plugins.ctx.harnessRuns.send(item.id, 'Second');
  assert.throws(
    () => app.runtime.plugins.ctx.harnessRuns.watch(item.id, first.id, 0, () => {}),
    /Run not found/,
  );
  const latest = app.runtime.plugins.ctx.harnessRuns.info(item.id);
  assert.ok(latest);
  assert.throws(
    () => app.runtime.plugins.ctx.harnessRuns.watch(item.id, latest.id, Number.NaN, () => {}),
    /Invalid event cursor/,
  );
});

test('append, torn write and fsync failures evict the writer without acknowledging a queued run', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + (await app.listen(0));
  const headers = { Authorization: 'Bearer ' + app.token };
  const rejected = app.runtime.plugins.ctx.harnessSessions.create();
  for (const invalid of [
    null,
    { message: 'Bad model', model: { provider: 42, id: 'invalid' } },
    { message: 'Bad thinking', thinkingLevel: 'invalid' },
    { message: 'Bad file', attachments: [{}] },
  ]) {
    const response = await fetch(base + '/api/sessions/' + rejected.id + '/runs', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(invalid),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(app.runtime.plugins.ctx.harnessRuns.info(rejected.id), undefined);
  const healthy = app.runtime.plugins.ctx.harnessSessions.create();
  for (const fault of ['append', 'torn', 'sync']) {
    const session = app.runtime.plugins.ctx.harnessSessions.create();
    const log = app.runtime.plugins.ctx.harnessSessions.log(session.id);
    const original = readFileSync(log.file);
    const write = fs.writeSync;
    let shortened = false;
    const mocked =
      fault === 'sync'
        ? t.mock.method(fs, 'fsyncSync', () => {
            throw new Error('Injected sync failure');
          })
        : t.mock.method(fs, 'writeSync', ((
            fd: number,
            bytes: Uint8Array,
            offset: number,
            length: number,
            position: number,
          ) => {
            if (fault === 'torn' && !shortened) {
              shortened = true;
              return write(fd, bytes, offset, Math.floor(length / 2), position);
            }
            throw new Error('Injected append failure');
          }) as typeof fs.writeSync);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => app.runtime.plugins.ctx.harnessRuns.startRun(session.id, 'Unacknowledged'),
        /Could not write/,
      );
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.throws(() => log.append({ type: 'branch' }), /closed/);
    assert.equal(app.runtime.plugins.ctx.harnessRuns.active(session.id), false);
    const damaged = readFileSync(log.file);
    if (fault === 'append') assert.deepEqual(damaged, original);
    if (fault === 'torn') {
      assert.ok(damaged.length > original.length);
      assert.notEqual(damaged.at(-1), 10);
    }
    if (fault === 'sync') assert.equal(damaged.at(-1), 10);
    const details = await (await fetch(base + '/api/sessions/' + session.id, { headers })).json();
    const status = await (await fetch(base + '/api/status', { headers })).json();
    assert.equal(details.run, undefined);
    assert.match(details.logError, /Injected/);
    assert.ok(status.sessionDiagnostics.some(({ id }: { id: string }) => id === session.id));
    assert.deepEqual(readFileSync(log.file), damaged, 'GET must leave even a torn tail intact');
    assert.equal(
      await app.runtime.plugins.ctx.harnessRuns.send(healthy.id, 'Healthy session'),
      'Mock response',
    );
    const reopened = app.runtime.plugins.ctx.harnessSessions.log(session.id);
    assert.notStrictEqual(reopened, log);
    assert.equal(
      app.runtime.plugins.ctx.harnessRuns.info(session.id)?.state,
      fault === 'sync' ? 'interrupted' : undefined,
    );
    if (fault === 'torn') assert.deepEqual(readFileSync(log.file), original);
    assert.equal(
      await app.runtime.plugins.ctx.harnessRuns.send(session.id, 'Accepted retry'),
      'Mock response',
    );
    assert.deepEqual(
      app.runtime.plugins.ctx.harnessSessions
        .log(session.id)
        .projection()
        .messages.filter(({ role }) => role === 'user')
        .map(({ content }) => (Array.isArray(content) ? content[0]?.text : content)),
      ['Accepted retry'],
    );
    assert.equal(app.runtime.plugins.ctx.harnessSessions.logError(session.id), undefined);
  }
});

test(
  'execution handles cancel only their own run and cannot cancel a later run in the same conversation',
  { timeout: 15000 },
  async (t) => {
    const entered = gate(),
      held = gate();
    let requests = 0;
    const mock = await createMockProvider(async () => {
      if (++requests > 1) {
        entered.release();
        await held.promise;
      }
      return 'Done';
    });
    const { root, paths } = createFixturePaths(mock.url);
    const app = await createMiniHarnessServer(paths);
    t.after(async () => {
      held.release();
      await app.close();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    });
    const { harnessSessions: registry, harnessRuns: runs } = app.runtime.plugins.ctx;
    const session = registry.create();
    const signal = new AbortController();
    const first = runs.submit(session.id, { message: 'First' }, signal.signal);
    assert.equal(await first.result, 'Done');
    const later = runs.submit(session.id, { message: 'Later' }, signal.signal);
    const cancelled = assert.rejects(later.result, /cancelled/);
    await entered.promise;
    assert.equal(first.cancel(), false);
    assert.equal(runs.active(session.id), true);
    assert.equal(later.cancel(), true);
    assert.equal(later.cancel(), false);
    held.release();
    await cancelled;
    assert.equal(runs.info(session.id)?.state, 'cancelled');
  },
);

test('retry looks up the failed delivery by its native entry identity', async (t) => {
  const mock = await createMockProvider(({ messages }) => {
    if (messages.at(-1)?.content.includes('fail this')) throw new Error('Provider rejected this request');
    return 'Earlier response';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const app = await createMiniHarnessServer(paths);
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { harnessSessions: registry, harnessRuns: runs } = app.runtime.plugins.ctx;
  const session = registry.create();
  await runs.send(session.id, 'Earlier user message');
  const log = registry.log(session.id);
  log.append({
    type: 'inbox-enqueued',
    item: { id: 'recover-this', mode: 'followUp', text: 'fail this queued input', images: [] },
  });
  const failed = runs.startRun(session.id, 'Manual input waiting for delivery');
  assert.equal(failed.state, 'queued');
  await assert.rejects(expectPresent(runs.completion(session.id), 'active run'));
  assert.equal(runs.info(session.id)?.state, 'failed');
  assert.ok(runs.info(session.id)?.inputEntryId);
  const delivered = log.projection().messages.find(({ submissionId }) => submissionId === failed.id);
  assert.equal(delivered?.inboxId, 'recover-this');
  assert.deepEqual(runs.retryInput(session.id, failed.id), {
    message: 'fail this queued input',
    attachments: [],
    missing: [],
    model: { provider: 'local-mock', id: 'mock-model' },
    thinkingLevel: undefined,
  });
  const attachment = {
    name: 'fixture.txt',
    mimeType: 'text/plain',
    data: Buffer.from('private text').toString('base64'),
  };
  const accepted = runs.startRun(session.id, 'fail this user input', { attachments: [attachment] });
  assert.equal(accepted.state, 'queued');
  await assert.rejects(expectPresent(runs.completion(session.id), 'active run'));
  assert.equal(
    log.projection().messages.find(({ submissionId }) => submissionId === accepted.id)?.inboxId,
    undefined,
  );
  assert.deepEqual(runs.retryInput(session.id, accepted.id)?.missing, []);
  assert.deepEqual(runs.retryInput(session.id, accepted.id)?.attachments, [attachment]);
  assert.throws(() => runs.retryInput(session.id, failed.id), /no longer the failed conversation run/);
});
