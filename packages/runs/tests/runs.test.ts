import { sendRun, activeRunCount } from '../../../test/support/runs.ts';
import { isViewMessage } from '@mini-harness/sessions/message';
import { expectPresent } from '../../../test/support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createMiniHarnessServer } from '../../../test/support/profile.ts';
import { SessionRegistry } from '@mini-harness/sessions/registry';
import { nativeFile } from '../../sessions/src/storage.ts';
import { WorkspaceCatalog } from '@mini-harness/workspaces/catalog';
import type { RunEvent } from '../src/stream.ts';
import { createFixturePaths, createMockProvider } from '../../../test/support/mock-provider.ts';

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
    const { taskId: runId } = await start.json();
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
    assert.equal(Boolean(app.runtime.plugins.ctx.harnessRuns.current(item.id)), true);
    const status = await (await fetch(base + '/api/sessions/' + item.id + '/runs', { headers })).json();
    assert.equal(status.run.state, 'running');
    const runs = app.runtime.plugins.ctx.harnessRuns;
    const pending = runs.current(item.id)?.result;
    const observed: RunEvent[] = [];
    const detach = runs.watch(item.id, runId, status.run.sequence, (event) => observed.push(event));
    const record = app.runtime.plugins.ctx.harnessSessions.log(item.id).append({
      type: 'plugin-record',
      owner: { pluginId: 'fixture', instanceId: 'fixture' },
      data: 'private record',
    });
    const branch = observed.find((event) => event.type === 'branch');
    assert.equal(branch?.leafId, record.id);
    assert.equal(branch?.display, undefined);
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
    const durable = readFileSync(nativeFile(paths, item), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const persistedRun = durable.filter((entry) => entry.type === 'task' && entry.run).at(-1);
    assert.ok(persistedRun);
    assert.equal(persistedRun.task.state, 'completed');
    assert.equal(persistedRun.task.id, finishedRun.id);
    assert.equal(persistedRun.run.state, undefined);
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
    const first = sendRun(app.runtime.plugins.ctx.harnessRuns, parent.id, 'Root one');
    const cancelled = assert.rejects(first, /cancelled/);
    const second = sendRun(app.runtime.plugins.ctx.harnessRuns, other.id, 'Root two');
    await entered.promise;
    assert.equal(activeRunCount(app.runtime.plugins.ctx), 2);
    const queued = app.runtime.plugins.ctx.harnessRuns.send(parent.id, {
      message: 'After the first run',
      mode: 'queue',
    });
    assert.equal(queued.queue.at(-1)?.id, queued.messageId);
    const child = app.runtime.plugins.ctx.harnessSessions.create({ parentId: parent.id });
    const childWork = sendRun(app.runtime.plugins.ctx.harnessRuns, child.id, 'Child');
    const childCancelled = assert.rejects(childWork, /cancelled/);
    const deleted = await app.runtime.plugins.ctx.harnessSessions.delete([parent.id]);
    await Promise.all([cancelled, childCancelled]);
    assert.deepEqual(new Set(deleted), new Set([parent.id, child.id]));
    assert.equal(app.runtime.plugins.ctx.harnessSessions.get(parent.id), undefined);
    assert.equal(Boolean(app.runtime.plugins.ctx.harnessRuns.current(other.id)), true);
    held.release();
    assert.equal(await second, 'Done');
    assert.equal(activeRunCount(app.runtime.plugins.ctx), 0);
    assert.equal(activeRunCount(app.runtime.plugins.ctx), 0);
  },
);

test('startup durably interrupts runs and delivers pending inbox messages', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  t.after(async () => {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const registry = new SessionRegistry(
    paths,
    (() => {
      const workspaces = new WorkspaceCatalog(paths);
      return () => workspaces;
    })(),
  );
  const parent = registry.create(),
    child = registry.create({ parentId: parent.id });
  registry.log(child.id).append({
    type: 'task',
    task: {
      id: 'fixture-run',
      owner: 'session:' + child.id,
      type: 'agent-run',
      state: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      cancellationRequested: false,
      outputCursor: 0,
    },
    run: { sequence: 1 },
  });
  registry.log(child.id).append({
    type: 'inbox-enqueued',
    item: { id: 'steer', mode: 'steer', text: 'Old instruction', images: [] },
  });
  registry.log(child.id).append({
    type: 'inbox-enqueued',
    item: { id: 'follow', mode: 'queue', text: 'Recovered follow-up', images: [] },
  });
  const file = nativeFile(paths, child);
  registry.dispose();
  const restored = new SessionRegistry(
    paths,
    (() => {
      const workspaces = new WorkspaceCatalog(paths);
      return () => workspaces;
    })(),
  );
  t.after(() => restored.dispose());
  const interrupted = restored.runSummary(child.id);
  assert.ok(interrupted);
  assert.equal(interrupted.state, 'interrupted');
  assert.deepEqual(
    restored.inspectLog(child.id, (log) =>
      log
        .projection()
        .timeline.flatMap((entry) => (entry.type === 'termination' ? [[entry.id, entry.state]] : [])),
    ),
    [['fixture-run', 'interrupted']],
  );
  assert.deepEqual(restored.descendants([parent.id]), [parent.id, child.id]);
  const bytes = readFileSync(file);
  assert.match(bytes.toString(), /"state":"interrupted"/);
  assert.deepEqual(
    restored.inspectLog(child.id, (log) => log.queue().map(({ id, state }) => [id, state])),
    [
      ['steer', 'pending'],
      ['follow', 'pending'],
    ],
  );
  assert.equal(restored.inspectLog(parent.id, (log) => log.entries()) !== undefined, false);
  assert.doesNotMatch(readFileSync(paths.registry, 'utf8'), /lastRuns|fixture-run/);
  restored.dispose();
  const restarted = await createMiniHarnessServer(paths);
  try {
    assert.equal(
      await sendRun(restarted.runtime.plugins.ctx.harnessRuns, child.id, 'New manual input'),
      'Mock response',
    );
    const prompts = mock.requests.map(({ messages }) => {
      const content = (messages as { role: string; content: string | { text: string }[] }[]).at(-1)?.content;
      return Array.isArray(content) ? content.map(({ text }) => text).join('') : content;
    });
    assert.deepEqual(
      prompts.filter((prompt) => !prompt?.startsWith('[agent ')),
      ['Old instruction', 'Recovered follow-up', 'New manual input'],
    );
    assert.equal(
      restarted.runtime.plugins.ctx.harnessSessions
        .log(child.id)
        .projection()
        .timeline.find((entry) => entry.type === 'termination')?.state,
      'interrupted',
    );
    assert.deepEqual(
      restarted.runtime.plugins.ctx.harnessSessions
        .log(child.id)
        .queue()
        .map(({ id, state }) => [id, state]),
      [],
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
  await sendRun(app.runtime.plugins.ctx.harnessRuns, item.id, 'First');
  const first = app.runtime.plugins.ctx.harnessRuns.info(item.id);
  const events: RunEvent[] = [];
  assert.ok(first);
  app.runtime.plugins.ctx.harnessRuns.watch(item.id, first.id, 0, (event) => events.push(event));
  assert.equal(events.length, 1);
  assert.ok(events[0]);
  assert.equal(events[0].type, 'snapshot');
  assert.ok(
    events[0].type === 'snapshot' &&
      events[0].timeline.filter(isViewMessage).some(({ role }) => role === 'assistant'),
  );
  await sendRun(app.runtime.plugins.ctx.harnessRuns, item.id, 'Second');
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
    const file = nativeFile(paths, session);
    const original = readFileSync(file);
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
        () =>
          app.runtime.plugins.ctx.harnessRuns.send(session.id, {
            message: 'Unacknowledged',
            origin: { source: 'user' },
          }),
        /Could not write/,
      );
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.throws(() => log.append({ type: 'branch' }), /closed/);
    assert.equal(Boolean(app.runtime.plugins.ctx.harnessRuns.current(session.id)), false);
    const damaged = readFileSync(file);
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
    assert.deepEqual(readFileSync(file), damaged, 'GET must leave even a torn tail intact');
    assert.equal(
      await sendRun(app.runtime.plugins.ctx.harnessRuns, healthy.id, 'Healthy session'),
      'Mock response',
    );
    const reopened = app.runtime.plugins.ctx.harnessSessions.log(session.id);
    assert.notStrictEqual(reopened, log);
    assert.equal(app.runtime.plugins.ctx.harnessRuns.info(session.id), undefined);
    for (const item of reopened.inbox())
      await app.runtime.plugins.ctx.harnessRuns.cancelQueue(session.id, item.id);
    if (fault === 'torn') assert.deepEqual(readFileSync(file), original);
    assert.equal(
      await sendRun(app.runtime.plugins.ctx.harnessRuns, session.id, 'Accepted retry'),
      'Mock response',
    );
    assert.deepEqual(
      app.runtime.plugins.ctx.harnessSessions
        .log(session.id)
        .projection()
        .timeline.filter(isViewMessage)
        .filter(({ role }) => role === 'user')
        .map(({ content }) => (Array.isArray(content) ? content[0]?.text : content)),
      ['Accepted retry'],
    );
    assert.equal(app.runtime.plugins.ctx.harnessSessions.logError(session.id), undefined);
  }
});

test(
  'task handles cancel only their own run and cannot cancel a later run in the same conversation',
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
    runs.send(session.id, { message: 'First' });
    const first = expectPresent(runs.current(session.id), 'first run');
    assert.equal(await first.result, 'Done');
    runs.send(session.id, { message: 'Later' });
    const later = expectPresent(runs.current(session.id), 'later run');
    const cancelled = assert.rejects(later.result, /cancelled/);
    await entered.promise;
    assert.equal(first.cancel(), false);
    assert.equal(Boolean(runs.current(session.id)), true);
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
  await sendRun(runs, session.id, 'Earlier user message');
  const log = registry.log(session.id);
  log.append({
    type: 'inbox-enqueued',
    item: { id: 'recover-this', mode: 'queue', text: 'fail this queued input', images: [] },
  });
  const failed = runs.send(session.id, { message: 'Manual input waiting for delivery', mode: 'queue' });
  runs.cancelQueue(session.id, failed.messageId);
  assert.equal(failed.run?.state, 'queued');
  const failedId = expectPresent(failed.taskId, 'failed task');
  await assert.rejects(expectPresent(runs.current(session.id)?.result, 'active run'));
  assert.equal(runs.info(session.id)?.state, 'failed');
  assert.ok(runs.info(session.id)?.inputEntryId);
  const delivered = log
    .projection()
    .timeline.filter(isViewMessage)
    .find(({ submissionId }) => submissionId === failedId);
  assert.equal(delivered?.inboxId, 'recover-this');
  assert.deepEqual(runs.retryInput(session.id, failedId), {
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
  const accepted = runs.send(session.id, {
    message: 'fail this user input',
    attachments: [attachment],
    origin: { source: 'user' },
  });
  assert.equal(accepted.run?.state, 'queued');
  const acceptedId = expectPresent(accepted.taskId, 'accepted task');
  await assert.rejects(expectPresent(runs.current(session.id)?.result, 'active run'));
  assert.equal(
    log
      .projection()
      .timeline.filter(isViewMessage)
      .find(({ submissionId }) => submissionId === acceptedId)?.inboxId,
    accepted.messageId,
  );
  assert.deepEqual(runs.retryInput(session.id, acceptedId)?.missing, []);
  assert.deepEqual(runs.retryInput(session.id, acceptedId)?.attachments, [attachment]);
  assert.throws(() => runs.retryInput(session.id, failedId), /no longer the failed conversation run/);
});

test(
  'Interrupt accepts multiple inputs, drains the existing tool and then resumes on one lane',
  { timeout: 15000 },
  async (t) => {
    const entered = gate();
    const abort = gate();
    const cleanup = gate();
    let calls = 0;
    const mock = await createMockProvider(({ messages }) =>
      messages.at(-1)?.content === 'Hold tool' ? { tool: 'hold_tool', args: {} } : 'Resumed',
    );
    const { root, paths } = createFixturePaths(mock.url);
    const app = await createMiniHarnessServer(paths);
    const ctx = app.runtime.plugins.ctx;
    const runs = ctx.harnessRuns;
    const sessions = ctx.harnessSessions;
    const remove = ctx.harnessTools.register({
      name: 'hold_tool',
      description: 'Wait for cleanup',
      parameters: { type: 'object' },
      async execute(_, { signal }) {
        calls++;
        signal.addEventListener('abort', abort.release, { once: true });
        entered.release();
        await cleanup.promise;
        signal.throwIfAborted();
        return { content: [] };
      },
    });
    t.after(async () => {
      cleanup.release();
      await remove();
      await app.close();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    });
    const { id } = sessions.create();
    const user = { source: 'user' } as const;
    runs.send(id, { message: 'Hold tool', origin: user });
    const first = expectPresent(runs.current(id), 'original run');
    const finished = assert.rejects(first.result, /Interrupted by a new message/);
    await entered.promise;
    assert.deepEqual(
      ctx.harnessTasks.list('session:' + id).map(({ type }) => type),
      ['agent-run'],
    );
    runs.send(id, { message: 'Interrupt one', origin: user });
    await abort.promise;
    runs.send(id, { message: 'Interrupt two', origin: user });
    assert.equal(runs.current(id)?.id, first.id);
    assert.equal(mock.requests.length, 1);
    cleanup.release();
    await finished;
    const replacement = expectPresent(runs.current(id), 'replacement run');
    assert.notEqual(replacement.id, first.id);
    assert.equal(await replacement.result, 'Resumed');
    assert.equal(calls, 1);
    assert.equal(mock.requests.length, 2);
    const timeline = sessions.log(id).projection().timeline.filter(isViewMessage);
    assert.equal(timeline.find((entry) => entry.role === 'toolResult')?.toolState, 'cancelled');
    assert.deepEqual(
      timeline.filter((entry) => entry.role === 'user').map(({ content }) => content),
      ['Hold tool', 'Interrupt one', 'Interrupt two'],
    );
  },
);

test('Stop persists the wake pause, preserves pending input and deduplicates notifications', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  let app = await createMiniHarnessServer(paths);
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { id } = app.runtime.plugins.ctx.harnessSessions.create();
  const message = {
    message: 'Background work is complete',
    origin: { source: 'task', taskId: 'task-123' } as const,
    messageId: 'task-123:settled',
    mode: 'queue' as const,
  };
  app.runtime.plugins.ctx.harnessRuns.stop(id);
  app.runtime.plugins.ctx.harnessRuns.send(id, message);
  await app.close();
  app = await createMiniHarnessServer(paths);
  const { harnessRuns: runs, harnessSessions: sessions } = app.runtime.plugins.ctx;
  assert.equal(runs.current(id), undefined);
  assert.equal(sessions.log(id).inboxPaused(), true);
  assert.equal(runs.send(id, message).queue.length, 1);
  await sendRun(runs, id, 'Resume', undefined, { mode: 'queue' });
  await runs.current(id)?.result;
  assert.equal(sessions.log(id).inboxPaused(), false);
  assert.equal(runs.send(id, message).queue.length, 0);
  assert.deepEqual(
    sessions
      .log(id)
      .projection()
      .timeline.filter(isViewMessage)
      .flatMap((entry) => (entry.origin?.taskId ? [entry.origin.taskId] : [])),
    ['task-123'],
  );
});
