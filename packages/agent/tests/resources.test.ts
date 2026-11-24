import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../../test/support/api-fixture.js';

test('live tool policy is reevaluated per turn without replacing session state', async (t) => {
  const { app, mock } = await fixture(t);
  const { runtime } = app;
  const parent = runtime.registry.create();
  const child = runtime.registry.create({ parentId: parent.id });
  const leaf = runtime.registry.create({ parentId: child.id });
  const tools = (id: string) => runtime.plugins.ctx.harnessTools.forSession(id).map(({ name }) => name);
  const log = runtime.registry.log(parent.id);
  await runtime.runs.send(parent.id, 'First');
  const firstMessage = runtime.agent.messages(parent.id)[0].id;
  await runtime.updateSettings({ pluginConfig: { subagents: { maxDepth: 2 } } });
  assert.ok(tools(child.id).includes('delegate'));
  assert.ok(!tools(leaf.id).includes('delegate'));
  await runtime.updateSettings({ plugins: { subagents: false, files: false } });
  await runtime.runs.send(parent.id, 'Next');
  assert.strictEqual(runtime.registry.log(parent.id), log);
  assert.equal(runtime.agent.messages(parent.id)[0].id, firstMessage);
  assert.ok(!tools(parent.id).includes('delegate'));
  assert.ok(!tools(leaf.id).includes('delegate'));
  assert.ok(!(mock.requests.at(-1)?.tools as { function: { name: string } }[]).some(({ function: tool }) => tool.name === 'read'));
  await runtime.updateSettings({ plugins: { skills: false } });
  assert.ok(!tools(parent.id).includes('load_skill'));
});
