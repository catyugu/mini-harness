import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, EntryTree, FiberState, type EntryOptions } from 'mini-harness/cordis';

declare module 'mini-harness/cordis' {
  interface Context { fixtureService: string }
}

test('Cordis activates consumers after their provider and drains them before it leaves', async () => {
  const context = new Context();
  const tree = new EntryTree();
  const effects: string[] = [];
  const consumer: EntryOptions = {
    context, id: 'consumer', module: 'consumer', config: {},
    load: () => ({
      inject: ['fixtureService'],
      apply(ctx) {
        const value = ctx.fixtureService;
        effects.push('consumer:' + value);
        ctx.effect(() => () => {
          assert.equal(ctx.fixtureService, value);
          effects.push('release consumer:' + value);
        });
      }
    })
  };
  const provider = (value: string): EntryOptions => ({
    context, id: 'provider', module: 'provider:' + value, config: {},
    load: () => ({
      apply(ctx) {
        ctx.provide('fixtureService', value);
        ctx.effect(() => () => { effects.push('release provider:' + value); });
      }
    })
  });

  await tree.update([consumer]);
  assert.equal(tree.get('consumer')?.fiber?.state, FiberState.PENDING);
  await tree.update([consumer, provider('first')]);
  const fiber = tree.get('consumer')?.fiber;
  assert.equal(fiber?.state, FiberState.ACTIVE);
  await tree.update([provider('second'), consumer]);
  assert.equal(tree.get('consumer')?.fiber, fiber);
  assert.deepEqual(effects, ['consumer:first', 'release consumer:first', 'release provider:first', 'consumer:second']);
  await tree.close();
  assert.deepEqual(effects.slice(-2), ['release consumer:second', 'release provider:second']);
});

test('each Cordis activation aborts and drains owned calls before releasing effects', async () => {
  const context = new Context();
  const effects: string[] = [];
  const fiber = context.plugin({
    apply(ctx) { ctx.effect(() => () => { effects.push('cleanup'); }); }
  });
  await fiber.await();
  const lifetime = fiber.signal;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const active = fiber.run(async signal => {
    enter();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    effects.push('drained');
  });
  const cancelled = assert.rejects(active, { name: 'AbortError' });
  await entered;
  await fiber.restart();
  await cancelled;
  assert.deepEqual(effects, ['drained', 'cleanup']);
  assert.ok(lifetime.aborted);
  assert.equal(fiber.signal.aborted, false);
  await fiber.dispose();
});
