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
  runtime.subscribe(({ state }) => states.push(state));
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
  assert.deepEqual(runtime.readOutput(task.id, 1)?.chunks, [{ sequence: 2, text: 'two' }]);
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
  const child = runtime.start({ owner: parent.id, creator: parent.id }, async ({ signal }) => {
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
