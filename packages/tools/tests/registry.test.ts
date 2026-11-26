import { Context } from 'mini-harness/cordis';
import toolsPlugin from '../src/manifest.ts';
import { createScopeKey } from '@mini-harness/plugin-api/scopes';
import { expectPresent } from '../../../test/support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { defineTool } from '../src/api.ts';
import { ToolRegistry } from '../src/registry.ts';
import { TaskRuntime } from '@mini-harness/tasks/runtime';

test('scoped tools inherit locally and disposal aborts and drains active execution', async () => {
  const workspace = createScopeKey();
  const child = createScopeKey(workspace);
  const registry = new ToolRegistry(new TaskRuntime());
  const make = (text: string) =>
    defineTool({
      name: 'inspect',
      description: text,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text }] };
      },
    });
  registry.register(make('root'));
  registry.register(make('workspace'), { scope: workspace });
  registry.register(make('child'), { scope: child });
  assert.equal(registry.list({ scope: child })[0].description, 'child');
  assert.equal(registry.list({ scope: workspace })[0].description, 'workspace');
  let entered: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const dispose = registry.register(
    defineTool({
      name: 'wait',
      description: 'Wait',
      parameters: Type.Object({}),
      async execute(_id, _args, signal) {
        entered();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
        return { content: [] };
      },
    }),
  );
  const pending = expectPresent(
    registry.list({ scope: child }).find(({ name }) => name === 'wait'),
    'wait tool',
  ).execute('call', {});
  const rejected = assert.rejects(pending, /no longer available/);
  await ready;
  await dispose();
  await rejected;
  assert.equal(
    registry.list({ scope: child }).some(({ name }) => name === 'wait'),
    false,
  );
});

test('a scoped replacement invalidates existing leases and removal restores inheritance', async () => {
  const parent = createScopeKey();
  const child = createScopeKey(parent);
  const registry = new ToolRegistry(new TaskRuntime());
  const make = (text: string) =>
    defineTool({
      name: 'inspect',
      description: text,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text }] };
      },
    });
  registry.register(make('application'));
  const original = registry.list({ scope: child })[0];
  const remove = registry.register(make('scoped'), { scope: parent });
  assert.throws(() => registry.register(make('duplicate'), { scope: parent }), /Duplicate entry in scope/);
  assert.equal(original.available(), false);
  await assert.rejects(original.execute('old', {}), /no longer available/);
  const replacement = registry.list({ scope: child })[0];
  assert.deepEqual((await replacement.execute('call', {})).content, [{ type: 'text', text: 'scoped' }]);
  assert.equal(registry.list()[0].description, 'application');
  await remove();
  await assert.rejects(replacement.execute('disposed', {}), /no longer available/);
  assert.equal(registry.list({ scope: child })[0].description, 'application');
});

test('Tools activates and registers a definition without Sessions or a policy provider', async () => {
  const ctx = new Context();
  ctx.provide('harnessTasks', new TaskRuntime().service());
  const fiber = ctx.plugin(toolsPlugin);
  try {
    await fiber;
    const tools = expectPresent(ctx.get('harnessTools'), 'standalone tools');
    const remove = tools.register(
      defineTool({
        name: 'example',
        description: 'Standalone tool',
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: 'text', text: 'ready' }] };
        },
      }),
    );
    try {
      assert.deepEqual((await tools.list()[0].execute('call', {})).content, [
        { type: 'text', text: 'ready' },
      ]);
    } finally {
      await remove();
    }
  } finally {
    await fiber.dispose();
  }
});

test('a registered tool uses one task for inline and independent background calls', async () => {
  const tasks = new TaskRuntime();
  const registry = new ToolRegistry(tasks);
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => { ready = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registry.register(defineTool({
    name: 'work',
    description: 'Work',
    parameters: Type.Object({ hold: Type.Boolean() }),
    async execute(_id, args, _signal, _update, context) {
      assert.ok(context);
      if (args.hold) { ready(); await gate; }
      return { content: [{ type: 'text', text: 'done' }] };
    },
  }));
  const tool = registry.list({ resourceId: 'session' })[0];
  assert.equal((await tool.execute('inline', { hold: false })).content[0].type, 'text');
  assert.equal(tasks.list().length, 0);
  const background = tool.start('background', { hold: true }, { retain: true });
  await entered;
  assert.equal(tasks.list('session:session').length, 1);
  assert.equal(tasks.get(background.id)?.state, 'running');
  release();
  await background.result;
  assert.equal(tasks.get(background.id)?.state, 'completed');
  assert.deepEqual(tasks.get(background.id)?.result, { content: [{ type: 'text', text: 'done' }] });
});
