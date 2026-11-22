import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { MiniHarnessRuntime } from '../src/agent.js';
import { projectTurns } from '../web/session-projection.js';
import { toolPresentation } from '../web/tool-presentation.js';
import { createFixturePaths, createMockProvider } from './helpers/mock-provider.js';
import type { RunInfo, ViewMessage } from '../src/protocol.js';

test('turn projection keeps the final answer separate and preserves errors and missing usage', () => {
  const messages: ViewMessage[] = [
    { id: 'u', runId: 'r', role: 'user', content: 'Task', timestamp: 1 },
    { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'Working' }, { type: 'toolCall', id: 't', name: 'read' }], timestamp: 2 },
    { id: 't', role: 'toolResult', toolCallId: 't', isError: true, content: 'Denied', timestamp: 3 },
    { id: 'f', role: 'assistant', content: 'Final answer', timestamp: 4 }
  ];
  const turns = projectTurns(messages, [{ id: 'r', state: 'completed' } as RunInfo]);
  assert.equal(turns[0].id, 'u');
  assert.equal(turns[0].final.id, 'f');
  assert.equal(turns[0].process.length, 2);
  assert.equal(turns[0].process[1].isError, true);
  assert.equal(turns[0].process[0].usage, undefined);
  assert.equal(projectTurns(messages.slice(0, -1))[0].final, undefined);
});

test('tool models disclose only trustworthy exit codes and retain actual diffs', () => {
  assert.equal(toolPresentation({ name: 'sandbox_shell', state: 'error', content: 'Cancelled' }).exitCode, undefined);
  assert.equal(toolPresentation({ name: 'sandbox_shell', state: 'finished', content: '{"code":null}' }).exitCode, undefined);
  assert.equal(toolPresentation({ name: 'sandbox_shell', state: 'finished', content: '{"code":0,"stdout":"ok"}' }).exitCode, 0);
  assert.equal(toolPresentation({ name: 'edit', state: 'finished', details: { diff: '-old\n+new' } }).diff, '-old\n+new');
});

test('Pi entry identities, tool durations and supplementary run facts survive restart without duplicating content', async (t) => {
  const mock = await createMockProvider(({ messages }) => messages.at(-1).role === 'tool' ? 'Final answer' : { tool: 'ls', args: {} });
  const { root, paths } = createFixturePaths(mock.url);
  let runtime = new MiniHarnessRuntime(paths);
  t.after(async () => { await runtime.stop(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.start();
  const item = runtime.registry.create();
  await runtime.send(item.id, 'Inspect this workspace');
  const before = await runtime.getConversation(item.id);
  assert.ok(before.messages.every(({ id }) => id));
  assert.equal(before.runs.length, 1);
  assert.equal(before.runs[0].state, 'completed');
  assert.ok(before.messages.find(({ role }) => role === 'toolResult').elapsedMs >= 0);
  assert.ok(before.messages.every(({ usage }) => usage === undefined), 'Mock provider omitted usage; SDK zero defaults are not reported');
  for (const entry of (await runtime.open(item.id)).sessionManager.getEntries()) {
    if (entry.type === 'custom' && entry.customType === 'mini-harness.run') assert.doesNotMatch(JSON.stringify(entry.data), /Final answer|Inspect this workspace/);
  }
  await runtime.stop(); runtime = new MiniHarnessRuntime(paths); await runtime.start();
  const after = await runtime.getConversation(item.id);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.runs, before.runs);
});
