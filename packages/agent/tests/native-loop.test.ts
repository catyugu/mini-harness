import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Type } from 'typebox';
import { NativeAgent } from '../agent.js';
import { SessionRegistry } from '../../sessions/registry.js';
import { WorkspaceCatalog } from '../../workspaces/catalog.js';
import { ToolRegistry } from '../../tools/registry.js';
import { defineTool } from '../../contracts/tools.js';
import type { LlmPort, NativeAssistantMessage, ToolCallPart } from '../../contracts/llm.js';
import { createFixturePaths } from '../../../test/helpers/mock-provider.js';

const model = { provider: 'fixture', id: 'native' };
const answer = (text = 'Done'): NativeAssistantMessage => ({ role: 'assistant', timestamp: Date.now(),
  provider: model.provider, model: model.id, content: [{ type: 'text', text }], stopReason: 'stop' });
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallPart => ({ type: 'toolCall', id, name, arguments: args });
const toolsAnswer = (...calls: ToolCallPart[]): NativeAssistantMessage => ({ ...answer(), content: calls, stopReason: 'toolUse' });

function fixture(t: TestContext, llm: LlmPort) {
  const { root, paths } = createFixturePaths('http://127.0.0.1:1/v1');
  const sessions = new SessionRegistry(paths, new WorkspaceCatalog(paths));
  t.after(() => { sessions.dispose(); rmSync(root, { recursive: true, force: true }); });
  const tools = new ToolRegistry();
  const agent = new NativeAgent(sessions, {
    models: () => ({ list: () => [], available: async () => [], resolve: (choice) => choice,
      capabilities: () => ({ id: model.id, name: 'Fixture', input: ['text', 'image'], contextWindow: 32000, maxTokens: 1024, reasoning: true }) }),
    llm: () => llm, tools: () => tools, allowsTool: () => true, prompt: () => ({ build: async () => 'Fixture' }), skills: () => undefined,
    prepare: async () => {}, defaultModel: () => model, rememberModel: () => {},
    policy: () => ({ maxTurns: 8, autoCompact: false }), observe: () => {}, transform: ({ content }) => content
  });
  const record = sessions.create();
  return { agent, sessions, tools, record };
}

test('duplicate tool call identities fail before executing any side effect', async (t) => {
  let requests = 0, executions = 0;
  const { agent, tools, record } = fixture(t, { async *stream() {
    yield { type: 'done', message: requests++ === 0 ? toolsAnswer(call('duplicate', 'change'), call('duplicate', 'change')) : answer() };
  } });
  tools.register('change', () => defineTool({ name: 'change', description: 'Change', parameters: Type.Object({}),
    async execute() { executions++; return { content: [{ type: 'text', text: 'changed' }] }; } }));
  await assert.rejects(agent.prompt(record, 'Change it', () => {}, { signal: new AbortController().signal }), /duplicate.*tool|tool.*duplicate/i);
  assert.equal(executions, 0);
  assert.equal(agent.size, 0);
});

test('tool execution uses the advertised registration and does not execute a hot replacement', async (t) => {
  let requests = 0, executions = 0;
  let replace: () => Promise<void>;
  const { agent, tools, record, sessions } = fixture(t, { async *stream() {
    if (requests++ === 0) {
      await replace();
      yield { type: 'done', message: toolsAnswer(call('first-call', 'change')) };
    } else yield { type: 'done', message: answer() };
  } });
  const dispose = tools.register('change', () => defineTool({ name: 'change', description: 'Original', parameters: Type.Object({}),
    async execute() { executions++; return { content: [{ type: 'text', text: 'original' }] }; } }));
  replace = async () => {
    await dispose();
    tools.register('change', () => defineTool({ name: 'change', description: 'Replacement', parameters: Type.Object({}),
      async execute() { executions++; return { content: [{ type: 'text', text: 'replacement' }] }; } }));
  };
  await agent.prompt(record, 'Change it', () => {}, { signal: new AbortController().signal });
  assert.equal(executions, 0);
  assert.equal(sessions.log(record.id).projection().messages.find((message) => message.role === 'toolResult').isError, true);
});

test('malformed tool arguments become durable error results without invoking the tool', async (t) => {
  let requests = 0, executions = 0;
  const { agent, tools, record, sessions } = fixture(t, { async *stream(request) {
    if (requests++ === 0) yield { type: 'done', message: toolsAnswer(call('invalid-call', 'inspect', { path: 42 })) };
    else {
      assert.equal(request.messages.at(-1).role, 'toolResult');
      assert.equal((request.messages.at(-1) as { isError: boolean }).isError, true);
      yield { type: 'done', message: answer('Recovered') };
    }
  } });
  tools.register('inspect', () => defineTool({ name: 'inspect', description: 'Inspect', parameters: Type.Object({ path: Type.String() }),
    async execute() { executions++; return { content: [] }; } }));
  assert.equal(await agent.prompt(record, 'Inspect', () => {}, { signal: new AbortController().signal }), 'Recovered');
  assert.equal(executions, 0);
  assert.equal(sessions.log(record.id).projection().messages.filter((message) => message.role === 'toolResult').length, 1);
});

test('cancellation closes the whole tool batch durably and never executes later tools', async (t) => {
  const controller = new AbortController();
  let ranFirst = 0, ranSecond = 0;
  const { agent, tools, record, sessions } = fixture(t, { async *stream() {
    yield { type: 'done', message: toolsAnswer(call('one', 'first'), call('two', 'second')) };
  } });
  tools.register('first', () => defineTool({ name: 'first', description: 'First', parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      ranFirst++;
      controller.abort(new Error('Stopped by test'));
      signal.throwIfAborted();
      return { content: [] };
    } }));
  tools.register('second', () => defineTool({ name: 'second', description: 'Second', parameters: Type.Object({}),
    async execute() { ranSecond++; return { content: [] }; } }));
  await assert.rejects(agent.prompt(record, 'Run tools', () => {}, { signal: controller.signal }), /Stopped by test/);
  const results = sessions.log(record.id).projection().messages.filter((message) => message.role === 'toolResult');
  assert.equal(ranFirst, 1); assert.equal(ranSecond, 0);
  assert.deepEqual(results.map(({ toolCallId, isError }) => [toolCallId, isError]), [['one', true], ['two', true]]);
  assert.equal(agent.size, 0);
});

test('interrupted calls receive an error record before the next prompt and are not retried', async (t) => {
  let executed = 0;
  const { agent, tools, record, sessions } = fixture(t, { async *stream(request) {
    const results = request.messages.filter((message) => message.role === 'toolResult');
    assert.equal(results.length, 1); assert.equal(results[0].isError, true);
    yield { type: 'done', message: answer() };
  } });
  tools.register('change', () => defineTool({ name: 'change', description: 'Change', parameters: Type.Object({}),
    async execute() { executed++; return { content: [] }; } }));
  sessions.log(record.id).append({ type: 'message', message: toolsAnswer(call('interrupted', 'change')) });
  await agent.prompt(record, 'Continue', () => {}, { signal: new AbortController().signal });
  assert.equal(executed, 0);
});

test('identical queued text preserves each attachment identity and is delivered exactly once', async (t) => {
  let entered: () => void, release: () => void, requests = 0;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const { agent, record, sessions } = fixture(t, { async *stream() {
    if (requests++ === 0) { entered(); await hold; }
    yield { type: 'done', message: answer() };
  } });
  const run = agent.prompt(record, 'Initial', () => {}, { signal: new AbortController().signal });
  await ready;
  const data = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  await agent.queueInput(record.id, 'Same text', 'followUp', [{ name: 'first.png', mimeType: 'image/png', data }]);
  await agent.queueInput(record.id, 'Same text', 'followUp', [{ name: 'second.png', mimeType: 'image/png', data }]);
  release(); await run;
  const users = sessions.log(record.id).projection().messages.filter((message) => message.role === 'user');
  assert.equal(requests, 3); assert.equal(users.length, 3);
  assert.deepEqual(users.slice(1).map(({ attachments }) => attachments[0].name), ['first.png', 'second.png']);
  assert.deepEqual(agent.read(record.id).queue, { steer: [], followUp: [] });
});
