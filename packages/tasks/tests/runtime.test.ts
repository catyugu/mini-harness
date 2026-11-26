import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskRuntime } from '../src/runtime.ts';
import { Context } from 'mini-harness/cordis';
import { TaskPool, type TaskHandle } from '../src/api.ts';

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
  const target = runtime.start({ owner: 'target' }, () => wake.promise);
  const pool = new TaskPool(1);
  const task = runtime.start({ owner: 'session:one', pool }, async (context) => {
    assert.equal(pool.active, 1);
    ready.release();
    await context.waitFor(target.id);
    assert.equal(pool.active, 1);
    return 42;
  });
  await ready.promise;
  assert.equal(pool.active, 0);
  assert.equal(runtime.get(task.id)?.state, 'waiting');
  wake.release();
  assert.equal(await task.result, 42);
  assert.equal(pool.active, 0);
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
  const background = runtime.start(
    { owner: 'session:parent', metadata: { creator: parent.id } },
    async () => {
      await released.promise;
      return 'independent';
    },
  );
  parent.cancel();
  released.release();
  await assert.rejects(parent.result);
  assert.equal(await background.result, 'independent');
  await runtime.removeOwner('session:parent');
  assert.equal(runtime.list().length, 0);
});

test('a durable projection fault cannot acknowledge a successful task', async () => {
  const runtime = new TaskRuntime();
  const task = runtime.start(
    {
      owner: 'one',
      commit({ task }) {
        if (task.state === 'completed') throw new Error('write failed');
      },
    },
    async () => 'not acknowledged',
  );
  await assert.rejects(task.result, /write failed/);
  assert.equal(runtime.get(task.id)?.state, 'failed');
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

test('arbitrary results are delivered without retaining arbitrary objects', async () => {
  const runtime = new TaskRuntime();
  const value = () => 42;
  const handle = runtime.start({ owner: 'session:one' }, async () => value);
  const terminal = runtime.wait(handle.id);
  assert.strictEqual(await handle.result, value);
  assert.equal((await terminal).state, 'completed');
  assert.equal(runtime.get(handle.id)?.result, undefined);
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

test('terminal observation cannot retroactively cancel a wait', async () => {
  const runtime = new TaskRuntime();
  const cancel = new AbortController();
  const gatekeeper = gate();
  const task = runtime.start({ owner: 'one' }, async () => {
    await gatekeeper.promise;
  });
  runtime.subscribe(({ task: snapshot }) => {
    if (snapshot.id === task.id && snapshot.state === 'completed') cancel.abort();
  });
  const result = runtime.wait(task.id, cancel.signal);
  gatekeeper.release();
  assert.equal((await result).state, 'completed');
});

test('a cancellation during running observation prevents invocation of executor code', async () => {
  const runtime = new TaskRuntime();
  let executed = false;
  runtime.subscribe(({ task }) => {
    if (task.state === 'running') runtime.cancel(task.id);
  });
  const handle = runtime.start({ owner: 'one' }, async () => {
    executed = true;
  });
  await assert.rejects(handle.result, /cancelled/);
  assert.equal(executed, false);
  assert.equal(runtime.get(handle.id)?.state, 'cancelled');
});

test('creator disposal does not cancel a task executed by another provider fiber', async () => {
  const runtime = new TaskRuntime();
  const ctx = new Context();
  ctx.provide('harnessTasks', runtime.service());
  const entered = gate();
  const cleaning = gate();
  const release = gate();
  const provider = ctx.plugin(() => {});
  await provider;
  let handle!: TaskHandle<void>;
  let observations = 0;
  const creator = ctx.plugin({
    inject: ['harnessTasks'],
    apply(caller) {
      caller.harnessTasks.subscribe(() => {
        observations++;
      });
      handle = caller.harnessTasks.start(
        { owner: 'resource', provider: provider.ctx },
        async ({ signal }) => {
          entered.release();
          await new Promise<void>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }).finally(async () => {
            cleaning.release();
            await release.promise;
          });
        },
      );
    },
  });
  try {
    await creator;
    await entered.promise;
    await creator.dispose();
    assert.equal(handle.signal.aborted, false);
    const count = observations;
    const stopping = provider.dispose();
    await cleaning.promise;
    assert.equal(handle.signal.aborted, true);
    assert.equal(runtime.get(handle.id)?.state, 'running');
    release.release();
    await stopping;
    await assert.rejects(handle.result);
    assert.equal(runtime.get(handle.id)?.state, 'cancelled');
    assert.equal(observations, count);
  } finally {
    release.release();
    await creator.dispose();
    await provider.dispose();
    await runtime.stop();
  }
});

test('observation data is detached from arbitrary result objects', async () => {
  const runtime = new TaskRuntime();
  const metadata = { nested: { value: 'original' } };
  const result = { value: 'answer' };
  const handle = runtime.start<{ value: string }>(
    { owner: 'one', metadata, project: (value) => value },
    async () => result,
  );
  metadata.nested.value = 'modified';
  assert.strictEqual(await handle.result, result);
  result.value = 'modified';
  const snapshot = runtime.get(handle.id)!;
  assert.deepEqual(snapshot.result, { value: 'answer' });
  assert.deepEqual(snapshot.metadata, { nested: { value: 'original' } });
  const copy = snapshot.result as { value: string };
  copy.value = 'modified again';
  assert.deepEqual(runtime.get(handle.id)?.result, { value: 'answer' });
});

test('pool resizing, queued cancellation and failed execution return capacity', async () => {
  const runtime = new TaskRuntime();
  const pool = new TaskPool(1);
  const hold = gate();
  const entered = gate();
  const first = runtime.start({ owner: 'one', pool }, async () => {
    entered.release();
    await hold.promise;
  });
  await entered.promise;
  const cancelled = runtime.start({ owner: 'two', pool }, async () => assert.fail('cancelled work ran'));
  const third = runtime.start({ owner: 'three', pool }, async () => {
    assert.equal(pool.active, 2);
    throw new Error('expected');
  });
  cancelled.cancel();
  await assert.rejects(cancelled.result);
  pool.limit = 2;
  await assert.rejects(third.result, /expected/);
  assert.equal(pool.active, 1);
  hold.release();
  await first.result;
  assert.equal(pool.active, 0);
});

test('task waits release capacity and reject circular waits', async () => {
  const runtime = new TaskRuntime();
  const pool = new TaskPool(1);
  let first!: TaskHandle<void>;
  let second!: TaskHandle<void>;
  first = runtime.start({ owner: 'one', pool }, async (task) => {
    assert.equal((await task.waitFor(second.id)).state, 'completed');
  });
  second = runtime.start({ owner: 'two', pool }, async (task) => {
    await assert.rejects(task.waitFor(first.id), /Circular task wait/);
  });
  await Promise.all([first.result, second.result]);
  assert.equal(pool.active, 0);
});

test('a lane stays exclusive while its task releases pool capacity', async () => {
  const runtime = new TaskRuntime();
  const pool = new TaskPool(1);
  const ready = gate();
  const wake = gate();
  const target = runtime.start({ owner: 'target' }, () => wake.promise);
  const first = runtime.start({ owner: 'one', lane: 'one', pool }, async (task) => {
    ready.release();
    await task.waitFor(target.id);
  });
  await ready.promise;
  assert.equal(runtime.active('one')?.id, first.id);
  assert.equal(pool.active, 0);
  assert.throws(() => runtime.start({ owner: 'one', lane: 'one' }, async () => {}), /occupied/);
  const second = runtime.start({ owner: 'two', lane: 'two', pool }, async () => 42);
  assert.equal(await second.result, 42);
  wake.release();
  await first.result;
  assert.equal(runtime.active('one'), undefined);
});
