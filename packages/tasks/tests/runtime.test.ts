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
