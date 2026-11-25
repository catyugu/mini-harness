import { Context } from 'mini-harness/cordis';
import toolsPlugin from '../src/manifest.ts';
import { createScopeKey } from '@mini-harness/plugin-api/scopes';
import { expectPresent } from '../../../test/support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { defineTool } from '../src/api.ts';
import { ToolRegistry } from '../src/registry.ts';

test('tool registry validates native JSON schemas before executing a plugin', async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registry.registerBinding('inspect', () =>
    defineTool({
      name: 'inspect',
      description: 'Inspect',
      parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      async execute(_id, args) {
        calls++;
        return { content: [{ type: 'text', text: args.path }] };
      },
    }),
  );
  const tool = registry.forSession('session')[0];
  await assert.rejects(tool.execute('call', { path: 1 }), /Invalid arguments/);
  await assert.rejects(tool.execute('call', { path: 'ok', extra: true }), /Invalid arguments/);
  assert.equal(calls, 0);
  assert.equal((await tool.execute('call', { path: 'ok' })).content[0].type, 'text');
  assert.equal(calls, 1);
});

test('scoped tools inherit locally and disposal aborts and drains active execution', async () => {
  const workspace = createScopeKey();
  const child = createScopeKey(workspace);
  const registry = new ToolRegistry();
  const make = (text: string) =>
    defineTool({
      name: 'inspect',
      description: text,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text }] };
      },
    });
  registry.registerBinding('inspect', () => make('root'));
  registry.registerBinding('inspect', () => make('workspace'), { scope: workspace });
  registry.registerBinding('inspect', () => make('child'), { scope: child });
  assert.equal(registry.forSession('child', child)[0].description, 'child');
  assert.equal(registry.forSession('sibling', workspace)[0].description, 'workspace');
  let entered: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const dispose = registry.registerBinding('wait', () =>
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
    registry.forSession('child', child).find(({ name }) => name === 'wait'),
    'wait tool',
  ).execute('call', {});
  const rejected = assert.rejects(pending, /no longer available/);
  await ready;
  await dispose();
  await rejected;
  assert.equal(
    registry.forSession('child', child).some(({ name }) => name === 'wait'),
    false,
  );
});

test('file-tool names follow the same scoped registration, restriction and lifetime rules as plugins', async () => {
  let allowed = true,
    denied = false;
  const workspace = createScopeKey();
  const child = createScopeKey(workspace);
  const outside = createScopeKey();
  const registry = new ToolRegistry(
    async () => (denied ? 'deny' : undefined),
    (_id, { name }) => allowed || name !== 'read',
  );
  const bind = (text: string) => () =>
    defineTool({
      name: 'read',
      description: text,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text }] };
      },
    });
  registry.registerBinding('read', bind('application'));
  assert.throws(() => registry.registerBinding('read', bind('duplicate')), /Duplicate entry in scope/);
  const releaseWorkspace = registry.registerBinding('read', bind('workspace'), { scope: workspace });
  assert.throws(
    () => registry.registerBinding('read', bind('duplicate'), { scope: workspace }),
    /Duplicate entry in scope/,
  );
  const releaseChild = registry.registerBinding('read', bind('child'), { scope: child });
  const tool = registry.forSession('child', child)[0];
  assert.equal(tool.description, 'child');
  assert.equal(registry.forSession('sibling', workspace)[0].description, 'workspace');
  assert.equal(registry.forSession('outside', outside)[0].description, 'application');
  assert.deepEqual((await tool.execute('call', {})).content, [{ type: 'text', text: 'child' }]);
  allowed = false;
  assert.deepEqual(registry.forSession('child', child), []);
  await assert.rejects(tool.execute('restricted', {}), /Tool denied by conversation or plugin policy/);
  allowed = true;
  denied = true;
  await assert.rejects(tool.execute('denied', {}), /Tool denied by conversation or plugin policy/);
  denied = false;
  await releaseChild();
  await assert.rejects(tool.execute('disposed', {}), /no longer available/);
  assert.equal(registry.forSession('child', child)[0].description, 'workspace');
  await releaseWorkspace();
  assert.equal(registry.forSession('child', child)[0].description, 'application');
});

test('a permission change while awaiting a tool decision prevents execution', async () => {
  let readOnly = false;
  let entered = () => {};
  let release = () => {};
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = new ToolRegistry(
    async () => {
      entered();
      await hold;
      return undefined;
    },
    (_id, tool) => !readOnly || tool.readOnly,
  );
  registry.registerBinding('modify', () =>
    defineTool({
      name: 'modify',
      description: 'Change a value',
      parameters: Type.Object({}),
      async execute() {
        assert.fail('A denied tool executed');
      },
    }),
  );
  const tool = registry.forSession('session')[0];
  const result = assert.rejects(tool.execute('call', {}), /Tool denied/);
  await checking;
  readOnly = true;
  assert.deepEqual(registry.forSession('session'), []);
  release();
  await result;
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
      assert.deepEqual((await tools.forSession('example')[0].execute('call', {})).content, [
        { type: 'text', text: 'ready' },
      ]);
    } finally {
      await remove();
    }
  } finally {
    await fiber.dispose();
  }
});
