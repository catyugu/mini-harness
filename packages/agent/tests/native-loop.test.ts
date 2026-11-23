import { expectPresent } from '../../../test/support/required.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Type } from 'typebox';
import { NativeAgent } from '../agent.js';
import { scheduleTools } from '../tool-pipeline.js';
import { SessionRegistry } from '@mini-harness/sessions/registry';
import { WorkspaceCatalog } from '@mini-harness/workspaces/catalog';
import { ToolRegistry } from '@mini-harness/tools/registry';
import { defineTool } from '@mini-harness/contracts/tools';
import type { LlmPort, NativeAssistantMessage, ToolCallPart } from '@mini-harness/contracts/llm';
import type { ModelRetry } from '@mini-harness/contracts/extensions';
import { createFixturePaths } from '../../../test/helpers/mock-provider.js';

const model = { provider: 'fixture', id: 'native' };
const answer = (text = 'Done'): NativeAssistantMessage => ({ role: 'assistant', timestamp: Date.now(),
  provider: model.provider, model: model.id, content: [{ type: 'text', text }], stopReason: 'stop' });
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallPart => ({ type: 'toolCall', id, name, arguments: args });
const toolsAnswer = (...calls: ToolCallPart[]): NativeAssistantMessage => ({ ...answer(), content: calls, stopReason: 'toolUse' });

function fixture(t: TestContext, llm: LlmPort, retryModel?: () => Promise<ModelRetry>) {
  const { root, paths } = createFixturePaths('http://127.0.0.1:1/v1');
  const sessions = new SessionRegistry(paths, new WorkspaceCatalog(paths));
  t.after(() => { sessions.dispose(); rmSync(root, { recursive: true, force: true }); });
  const tools = new ToolRegistry();
  const agent = new NativeAgent(sessions, {
    models: () => ({ list: () => [], available: async () => [], resolve: (choice) => choice,
      capabilities: () => ({ id: model.id, name: 'Fixture', input: ['text', 'image'], contextWindow: 32000, maxTokens: 1024, reasoning: true }) }),
    llm: () => llm, tools: () => tools, allowsTool: () => true, prompt: () => ({ build: async () => 'Fixture' }), skills: () => undefined,
    prepare: async () => {}, defaultModel: () => model, rememberModel: () => {},
    policy: () => ({ maxTurns: 8, autoCompact: false }), retryModel, observe: () => {}, transform: ({ content }) => content
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
  assert.equal(sessions.log(record.id).projection().messages.find((message) => message.role === 'toolResult')?.isError, true);
});

test('malformed tool arguments become durable error results without invoking the tool', async (t) => {
  let requests = 0, executions = 0;
  const { agent, tools, record, sessions } = fixture(t, { async *stream(request) {
    if (requests++ === 0) yield { type: 'done', message: toolsAnswer(call('invalid-call', 'inspect', { path: 42 })) };
    else {
      assert.equal(request.messages.at(-1)?.role, 'toolResult');
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
      signal?.throwIfAborted();
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
  let entered: () => void = () => { throw new Error('Not started'); };
  let release: () => void = () => { throw new Error('Not started'); };
  let requests = 0;
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
  assert.deepEqual(users.slice(1).map(({ attachments }) => expectPresent(attachments?.[0], 'queued attachment').name), ['first.png', 'second.png']);
  assert.deepEqual(agent.read(record.id).queue, []);
});

test('opted-in tools overlap, persist independently and respect serial barriers', { timeout: 5000 }, async (t) => {
  let requests = 0;
  const { agent, tools, record, sessions } = fixture(t, { async *stream() {
    yield { type: 'done', message: requests++ === 0 ? toolsAnswer(
      call('before', 'serial'), call('one', 'parallel', { wait: true }),
      call('two', 'parallel', { wait: false }), call('after', 'serial')) : answer() };
  } });
  const log = () => sessions.log(record.id).projection().contextMessages.filter((message) => message.role === 'toolResult');
  const started: string[] = [];
  let release: () => void = () => { throw new Error('Not started'); };
  const waitForDurability = new Promise<void>((resolve) => { release = resolve; });
  tools.register('parallel', () => defineTool({
    name: 'parallel', description: 'Parallel', parameters: Type.Object({ wait: Type.Boolean() }),
    isConcurrencySafe: ({ wait }) => typeof wait === 'boolean',
    async execute(id, { wait }, signal) {
      started.push(id);
      if (wait) {
        await Promise.race([waitForDurability, new Promise<never>((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      }
      return { content: [{ type: 'text', text: id }] };
    }
  }));
  tools.register('serial', () => defineTool({
    name: 'serial', description: 'Serial', parameters: Type.Object({}),
    async execute(id) { started.push(id); return { content: [] }; }
  }));
  const snapshots: string[][] = [];
  await agent.prompt(record, 'Run batch', (event) => {
    if (event.type === 'tool' && event.state === 'finished') {
      snapshots.push(log().map(({ toolCallId }) => toolCallId));
      if (event.id === 'two') release();
    }
  }, { signal: AbortSignal.timeout(3000) });
  assert.deepEqual(started, ['before', 'one', 'two', 'after']);
  assert.deepEqual(snapshots, [['before'], ['before', 'two'], ['before', 'two', 'one'], ['before', 'two', 'one', 'after']]);
});

test('the retry policy cannot replay a model attempt after output has streamed', async (t) => {
  let requests = 0, retries = 0;
  const { agent, record } = fixture(t, { async *stream() {
    requests++;
    yield { type: 'text-delta', text: 'Partial' };
    throw new Error('Transport closed after output');
  } }, async () => { retries++; return {}; });
  const deltas: string[] = [];
  await assert.rejects(agent.prompt(record, 'Generate', (event) => {
    if (event.type === 'delta') deltas.push(event.text);
  }, { signal: new AbortController().signal }), /Transport closed after output/);
  assert.deepEqual({ requests, retries, deltas }, { requests: 1, retries: 0, deltas: ['Partial'] });
});

test('a fatal pipeline failure stops dispatch and drains active calls', async () => {
  const tool = defineTool({ name: 'parallel', description: 'Parallel', parameters: Type.Object({}),
    isConcurrencySafe: () => true, async execute() { return { content: [] }; } });
  const tools = new Map([[tool.name, tool]]);
  const calls = Array.from({ length: 18 }, (_, index) => call(String(index), 'parallel'));
  const started: string[] = [];
  let drained = 0;
  await assert.rejects(scheduleTools(calls, tools, new AbortController().signal, async (call, _tool, signal) => {
    started.push(call.id);
    if (call.id === '0') throw new Error('Log write failed');
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    drained++;
  }), /Log write failed/);
  assert.equal(started.length, 16);
  assert.equal(drained, 15);
});

test('a queued follow-up can preselect the next model and thinking level', async (t) => {
  let release: () => void = () => { throw new Error('Not started'); };
  let entered: () => void = () => { throw new Error('Not started'); };
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  t.after(() => release());
  const seen: { model: string; thinking: string }[] = [];
  const { agent, record, sessions } = fixture(t, { async *stream(request) {
    seen.push({ model: request.model.id, thinking: request.thinkingLevel ?? 'off' });
    if (seen.length === 1) { entered(); await held; }
    yield { type: 'done', message: answer() };
  } });
  const pending = agent.prompt(record, 'Initial', () => {}, { signal: new AbortController().signal });
  await started;
  await agent.queueInput(record.id, 'Follow up', 'followUp', undefined, {
    model: { provider: 'fixture', id: 'next-model' }, thinkingLevel: 'medium'
  });
  release();
  await pending;
  assert.deepEqual(seen, [{ model: 'native', thinking: 'off' }, { model: 'next-model', thinking: 'medium' }]);
  assert.deepEqual(sessions.log(record.id).projection().model, { provider: 'fixture', id: 'next-model' });
  assert.deepEqual(sessions.log(record.id).projection().inbox, []);
});
