import { expectPresent } from '../../../test/support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { defineTool, registerToolBinding } from '@mini-harness/contracts/tools';
import { ToolRegistry } from '../registry.js';

test('tool registry validates native JSON schemas before executing a plugin', async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registry[registerToolBinding]('inspect', () => defineTool({ name: 'inspect', description: 'Inspect',
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, args) { calls++; return { content: [{ type: 'text', text: args.path }] }; } }));
  const tool = registry.forSession('session')[0];
  await assert.rejects(tool.execute('call', { path: 1 }), /Invalid arguments/);
  await assert.rejects(tool.execute('call', { path: 'ok', extra: true }), /Invalid arguments/);
  assert.equal(calls, 0);
  assert.equal((await tool.execute('call', { path: 'ok' })).content[0].type, 'text');
  assert.equal(calls, 1);
});

test('scoped tools inherit locally and disposal aborts and drains active execution', async () => {
  const registry = new ToolRegistry((id) => ['workspace:a', ...(id === 'child' ? ['session:child'] : [])]);
  const make = (text: string) => defineTool({ name: 'inspect', description: text, parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text }] }; } });
  registry[registerToolBinding]('inspect', () => make('root'));
  registry[registerToolBinding]('inspect', () => make('workspace'), { scope: 'workspace:a' });
  registry[registerToolBinding]('inspect', () => make('child'), { scope: 'session:child' });
  assert.equal(registry.forSession('child')[0].description, 'child');
  assert.equal(registry.forSession('sibling')[0].description, 'workspace');
  let entered: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const dispose = registry[registerToolBinding]('wait', () => defineTool({ name: 'wait', description: 'Wait', parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      entered();
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { content: [] };
    } }));
  const pending = expectPresent(registry.forSession('child').find(({ name }) => name === 'wait'), 'wait tool').execute('call', {});
  const rejected = assert.rejects(pending, /no longer available/);
  await ready;
  await dispose();
  await rejected;
  assert.equal(registry.forSession('child').some(({ name }) => name === 'wait'), false);
});

test('file-tool names follow the same scoped registration, restriction and lifetime rules as plugins', async () => {
  let allowed = true, denied = false;
  const registry = new ToolRegistry((id) => id === 'outside' ? ['workspace:other'] :
    ['workspace:one', ...(id === 'child' ? ['session:child'] : [])],
  async () => denied ? 'deny' : undefined, () => ({ readOnly: false, disabledTools: allowed ? [] : ['read'] }));
  const bind = (text: string) => () => defineTool({ name: 'read', description: text, parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text }] }; } });
  registry[registerToolBinding]('read', bind('application'));
  assert.throws(() => registry[registerToolBinding]('read', bind('duplicate')), /Duplicate tool in scope/);
  const releaseWorkspace = registry[registerToolBinding]('read', bind('workspace'), { scope: 'workspace:one' });
  assert.throws(() => registry[registerToolBinding]('read', bind('duplicate'), { scope: 'workspace:one' }), /Duplicate tool in scope/);
  const releaseChild = registry[registerToolBinding]('read', bind('child'), { scope: 'session:child' });
  const tool = registry.forSession('child')[0];
  assert.equal(tool.description, 'child');
  assert.equal(registry.forSession('sibling')[0].description, 'workspace');
  assert.equal(registry.forSession('outside')[0].description, 'application');
  assert.deepEqual((await tool.execute('call', {})).content, [{ type: 'text', text: 'child' }]);
  allowed = false;
  assert.deepEqual(registry.forSession('child'), []);
  await assert.rejects(tool.execute('restricted', {}), /Tool denied by conversation or plugin policy/);
  allowed = true;
  denied = true;
  await assert.rejects(tool.execute('denied', {}), /Tool denied by conversation or plugin policy/);
  denied = false;
  await releaseChild();
  await assert.rejects(tool.execute('disposed', {}), /no longer available/);
  assert.equal(registry.forSession('child')[0].description, 'workspace');
  await releaseWorkspace();
  assert.equal(registry.forSession('child')[0].description, 'application');
});
