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

test('EntryTree distinguishes configuration, dependency changes and failed setup', async () => {
  const context = new Context();
  const tree = new EntryTree();
  let starts = 0;
  const load: EntryOptions['load'] = () => ({
    apply(_ctx, config) {
      starts++;
      if (config.fail) throw new Error('rejected config');
    },
  });
  const entry = { context, id: 'test', module: 'test', config: { a: 1, b: 2 }, load };
  await tree.update([entry]);
  await assert.rejects(tree.update([entry, entry]), /Duplicate loader entry ID/);
  await tree.update([{ ...entry, config: { b: 2, a: 1 } }]);
  assert.equal(starts, 1);
  await tree.update([{ ...entry, inject: ['fixtureService'] }]);
  assert.equal(tree.get(entry.id)?.fiber?.state, FiberState.PENDING);
  const failed = await tree.update([{ ...entry, config: { fail: true } }]);
  assert.match(String(failed.get(entry.id)), /rejected config/);
  assert.equal((await tree.update([entry])).size, 0);
  assert.equal(tree.get(entry.id)?.active, true);
  await tree.close();
  await assert.rejects(tree.update([entry]), /closed/);
  assert.equal(context.registry.size, 0);
});

test('event dispatch shares scoped priority and skips removed listeners after awaiting', async () => {
  const context = new Context();
  const event = Symbol('test');
  const visits: string[] = [];
  const included = context.extend();
  const excluded = context.extend();
  const scope = context.extend({ [Context.filter]: (listener: Context) => listener === included });
  const remove = included.on(event, () => { visits.push('removed'); }, { order: 4 });
  excluded.on(event, () => { visits.push('excluded'); });
  excluded.on(event, () => { visits.push('global'); }, { global: true, order: 3 });
  included.on(event, async () => { visits.push('first'); await Promise.resolve(); remove(); }, { order: 1 });
  assert.equal(context.events.listeners(event, scope).length, 3);
  await context.serial(scope, event);
  assert.deepEqual(visits, ['first', 'global']);
  visits.length = 0;
  context.emit(scope, event);
  assert.deepEqual(visits, ['first', 'global']);
});
