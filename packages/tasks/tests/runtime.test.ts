import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskRuntime } from '../src/runtime.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('cancellation is a request until execution finishes cleaning up', async () => {
  const runtime = new TaskRuntime();
  const entered = gate();
  const cleanup = gate();
  const states: string[] = [];
  runtime.subscribe(({ task: { state } }) => states.push(state));
  const task = runtime.start({ owner: 'session:one' }, async ({ signal, write }) => {
    write('one');
    entered.release();
    await cleanup.promise;
    write('two');
    signal.throwIfAborted();
  });
  assert.equal(runtime.get(task.id)?.state, 'queued');
  await entered.promise;
  assert.equal(task.cancel(), true);
  assert.equal(task.cancel(), false);
  assert.equal(runtime.get(task.id)?.state, 'running');
  assert.equal(runtime.get(task.id)?.cancellationRequested, true);
  cleanup.release();
  await assert.rejects(task.result, /cancelled/);
  assert.equal(runtime.get(task.id)?.state, 'cancelled');
  assert.equal(states.filter((state) => state === 'cancelled').length, 1);
  assert.deepEqual(runtime.readOutput(task.id, 3)?.chunks, [
    { start: 3, end: 6, channel: 'log', text: 'two' },
  ]);
});

test('suspending releases admission and resumes only after reacquisition', async () => {
  const runtime = new TaskRuntime();
  const ready = gate();
  const wake = gate();
  let held = 0;
  const acquire = async () => {
    held++;
    return () => held--;
  };
  const task = runtime.start({ owner: 'session:one', acquire }, async (context) => {
    assert.equal(held, 1);
    await context.suspend(async () => {
      ready.release();
      await wake.promise;
    });
    assert.equal(held, 1);
    return 42;
  });
  await ready.promise;
  assert.equal(held, 0);
  assert.equal((await runtime.wait(task.id, ({ state }) => state === 'waiting')).state, 'waiting');
  wake.release();
  assert.equal(await task.result, 42);
  assert.equal(held, 0);
  assert.equal((await runtime.wait(task.id)).state, 'completed');
  await runtime.removeOwner('session:one');
  assert.equal(runtime.get(task.id), undefined);
});

test('queued cancellation does not run user code; shutdown interrupts active work', async () => {
  const runtime = new TaskRuntime();
  let executed = false;
  const queued = runtime.start({ owner: 'one' }, async () => {
    executed = true;
  });
  queued.cancel();
  await assert.rejects(queued.result);
  assert.equal(executed, false);
  const entered = gate();
  const running = runtime.start({ owner: 'two' }, async ({ signal }) => {
    entered.release();
    await new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  await entered.promise;
  await runtime.stop();
  assert.equal(runtime.get(running.id)?.state, 'interrupted');
  assert.throws(() => runtime.start({ owner: 'three' }, async () => {}), /closing/);
});

test('ownership, not creation, controls cancellation and deletion', async () => {
  const runtime = new TaskRuntime();
  const entered = gate();
  const released = gate();
  const parent = runtime.start({ owner: 'session:parent' }, async ({ signal }) => {
    entered.release();
    await released.promise;
    signal.throwIfAborted();
  });
  await entered.promise;
  const child = runtime.start({ owner: 'task:' + parent.id, creator: parent.id }, async ({ signal }) => {
    await new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const background = runtime.start({ owner: 'session:parent', creator: parent.id }, async () => {
    await released.promise;
    return 'independent';
  });
  await runtime.wait(child.id, ({ state }) => state === 'running');
  parent.cancel();
  released.release();
  await assert.rejects(parent.result);
  await assert.rejects(child.result);
  assert.equal(await background.result, 'independent');
  assert.equal(runtime.get(child.id)?.state, 'cancelled');
  await runtime.removeOwner('session:parent');
  assert.equal(runtime.list().length, 0);
});

test('a durable projection fault cannot acknowledge a successful task', async () => {
  const runtime = new TaskRuntime();
  const task = runtime.start(
    {
      owner: 'session:one',
      record(snapshot) {
        if (snapshot.state === 'completed') throw new Error('write failed');
      },
    },
    async () => 'not acknowledged',
  );
  await assert.rejects(task.result, /write failed/);
  assert.equal(runtime.get(task.id)?.state, 'failed');
});

test('overlapping suspensions resume together, including caught wait failures', async () => {
  const runtime = new TaskRuntime();
  const first = gate();
  const second = gate();
  const waiting = gate();
  let held = 0;
  const task = runtime.start(
    {
      owner: 'session:one',
      acquire: async () => {
        held++;
        return () => held--;
      },
    },
    async (context) => {
      const a = context
        .suspend(async () => {
          await first.promise;
          throw new Error('wait failed');
        })
        .catch((error) => {
          assert.equal(held, 1);
          assert.match(String(error), /wait failed/);
        });
      const b = context
        .suspend(async () => {
          await second.promise;
          return 1;
        })
        .then((value) => {
          assert.equal(held, 1);
          return value;
        });
      waiting.release();
      await Promise.all([a, b]);
    },
  );
  await waiting.promise;
  first.release();
  await Promise.resolve();
  assert.equal(held, 0);
  assert.equal(runtime.get(task.id)?.state, 'waiting');
  second.release();
  await task.result;
  assert.equal(held, 0);
});

test('owner removal rejects new work immediately and emits deletion after cleanup', async () => {
  const runtime = new TaskRuntime();
  const entered = gate();
  const release = gate();
  const events: string[] = [];
  runtime.subscribe(({ type }) => events.push(type));
  const task = runtime.start({ owner: 'session:one' }, async () => {
    entered.release();
    await release.promise;
  });
  await entered.promise;
  const removing = runtime.removeOwner('session:one');
  assert.throws(() => runtime.start({ owner: 'session:one' }, async () => {}), /removed/);
  assert.strictEqual(runtime.removeOwner('session:one'), removing);
  release.release();
  await removing;
  await assert.rejects(task.result);
  assert.equal(runtime.get(task.id), undefined);
  assert.equal(events.at(-1), 'deleted');
});

test('ephemeral results are delivered without retaining arbitrary objects', async () => {
  const runtime = new TaskRuntime();
  const observed: string[] = [];
  runtime.subscribe(({ type }) => observed.push(type));
  const value = () => 42;
  const handle = runtime.start({ owner: 'session:one', retain: false }, async () => value);
  const terminal = runtime.wait(handle.id);
  assert.strictEqual(await handle.result, value);
  assert.equal((await terminal).state, 'completed');
  assert.equal(runtime.get(handle.id), undefined);
  assert.equal(observed.at(-1), 'deleted');
});

test('output uses UTF-8 byte offsets and preserves channel and Unicode boundaries', async () => {
  const runtime = new TaskRuntime();
  const handle = runtime.start({ owner: 'session:one' }, async (context) => {
    context.write('😀'.repeat(300000), 'stdout');
    context.write('完', 'stderr');
  });
  await handle.result;
  const output = runtime.readOutput(handle.id)!;
  assert.equal(output.cursor, 1200003);
  assert.equal(output.truncated, true);
  assert.ok(output.chunks[0].start > 0);
  assert.ok(!output.chunks[0].text.includes('�'));
  assert.equal(output.chunks.at(-1)?.channel, 'stderr');
  assert.equal(runtime.readOutput(handle.id, 1200000)?.chunks[0].text, '完');
});
