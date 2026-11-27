import { runTool, toolAvailable } from '../src/execution.ts';
import { Context } from 'mini-harness/cordis';
import toolsPlugin from '../src/manifest.ts';
import { createScopeKey } from '@mini-harness/plugin-api/scopes';
import { expectPresent } from '../../../test/support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { defineTool } from '../src/api.ts';
import { ToolRegistry } from '../src/registry.ts';

test('scoped tools inherit locally and unregistering cancels an active call', async () => {
  const workspace = createScopeKey();
  const child = createScopeKey(workspace);
  const registry = new ToolRegistry();
  const context = new Context();
  const make = (text: string) =>
    defineTool({
      name: 'inspect',
      description: text,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text }] };
      },
    });
  registry.register(make('root'), { context });
  registry.register(make('workspace'), { context, scope: workspace });
  registry.register(make('child'), { context, scope: child });
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
      async execute(_args, { signal }) {
        entered();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
        return { content: [] };
      },
    }),
    { context },
  );
  const pending = runTool(
    expectPresent(
      registry.list({ scope: child }).find(({ name }) => name === 'wait'),
      'wait tool',
    ),
    'call',
    {},
  );
  const rejected = assert.rejects(pending, /no longer available/);
  await ready;
  dispose();
  await rejected;
  assert.equal(
    registry.list({ scope: child }).some(({ name }) => name === 'wait'),
    false,
  );
});

test('a scoped replacement invalidates already selected definitions and removal restores inheritance', async () => {
  const parent = createScopeKey();
  const child = createScopeKey(parent);
  const registry = new ToolRegistry();
  const context = new Context();
  const make = (text: string) =>
    defineTool({
      name: 'inspect',
      description: text,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text }] };
      },
    });
  registry.register(make('application'), { context });
  const original = registry.list({ scope: child })[0];
  const remove = registry.register(make('scoped'), { context, scope: parent });
  assert.throws(
    () => registry.register(make('duplicate'), { context, scope: parent }),
    /Duplicate entry in scope/,
  );
  assert.equal(toolAvailable(original), false);
  assert.throws(() => runTool(original, 'old', {}), /no longer available/);
  const replacement = registry.list({ scope: child })[0];
  assert.deepEqual((await runTool(replacement, 'call', {})).content, [{ type: 'text', text: 'scoped' }]);
  assert.equal(registry.list()[0].description, 'application');
  remove();
  assert.throws(() => runTool(replacement, 'disposed', {}), /no longer available/);
  assert.equal(registry.list({ scope: child })[0].description, 'application');
});

test('Tools activates and registers a definition without Sessions or a policy provider', async () => {
  const ctx = new Context();
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
      assert.deepEqual((await runTool(tools.list()[0], 'call', {})).content, [
        { type: 'text', text: 'ready' },
      ]);
    } finally {
      remove();
    }
  } finally {
    await fiber.dispose();
  }
});

test('unregister cancels immediately and provider disposal drains before resource cleanup', async () => {
  const ctx = new Context();
  const tools = ctx.plugin(toolsPlugin);
  await tools;
  let entered!: () => void;
  let aborted!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let released = false;
  let unregister!: () => void;
  const provider = ctx.inject(['harnessTools'], (plugin) => {
    plugin.effect(() => () => {
      released = true;
    });
    plugin.effect(() => {
      unregister = plugin.harnessTools.register(
        defineTool({
          name: 'inspect',
          description: 'Inspect',
          parameters: Type.Object({}),
          async execute(_args, { signal }) {
            signal.addEventListener('abort', aborted, { once: true });
            entered();
            await hold;
            signal.throwIfAborted();
            return { content: [] };
          },
        }),
      );
      return unregister;
    });
  });
  try {
    await provider;
    const tool = ctx.harnessTools.list()[0];
    const pending = assert.rejects(runTool(tool, 'test', {}), { name: 'AbortError' });
    await started;
    try {
      assert.equal(unregister(), undefined);
      await cancelled;
      assert.equal(released, false);
      assert.equal(toolAvailable(tool), false);
    } finally {
      const unload = provider.dispose();
      assert.equal(released, false);
      finish();
      await unload;
    }
    await pending;
    assert.equal(released, true);
  } finally {
    await tools.dispose();
  }
});
