import { isViewMessage } from '@mini-harness/sessions/message';
import { Context } from 'mini-harness/cordis';
import { fixture as httpFixture } from '../../../test/support/api-fixture.ts';
import { prepareInput } from '@mini-harness/input/prepare';
import type { ThinkingLevel } from '@mini-harness/llm/vocabulary';
import { expectPresent } from '../../../test/support/required.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Type } from 'typebox';
import { AgentLoop } from '../src/agent.ts';
import { Inbox } from '../../runs/src/inbox.ts';
import type { Attachment } from '@mini-harness/input/message';
import type { InboxItem } from '@mini-harness/sessions/log-api';
import type { AgentEvent } from '../../runs/src/stream.ts';
import { SessionRun } from '../../runs/src/session-run.ts';
import { nativeExecutor } from '@mini-harness/tools/execution';
import { basicCompaction } from '../src/compaction.ts';
import { SessionRegistry } from '@mini-harness/sessions/registry';
import { WorkspaceCatalog } from '@mini-harness/workspaces/catalog';
import { ToolRegistry } from '@mini-harness/tools/registry';
import { defineTool, toolResultState } from '@mini-harness/tools/api';
import type { LlmPort, NativeAssistantMessage, ToolCallPart } from '@mini-harness/llm/api';
import type { ModelRetry } from '../src/events.ts';
import { createFixturePaths } from '../../../test/helpers/mock-provider.ts';

const model = { provider: 'fixture', id: 'native' };
const answer = (text = 'Done'): NativeAssistantMessage => ({
  role: 'assistant',
  timestamp: Date.now(),
  provider: model.provider,
  model: model.id,
  content: [{ type: 'text', text }],
  stopReason: 'stop',
});
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallPart => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const toolsAnswer = (...calls: ToolCallPart[]): NativeAssistantMessage => ({
  ...answer(),
  content: calls,
  stopReason: 'toolUse',
});

function fixture(
  t: TestContext,
  llm: Pick<LlmPort, 'stream'>,
  retryModel?: () => Promise<ModelRetry>,
  thinkingLevels: (id: string) => ThinkingLevel[] | undefined = () => undefined,
  executor = nativeExecutor,
) {
  const { root, paths } = createFixturePaths('http://127.0.0.1:1/v1');
  const sessions = new SessionRegistry(
    paths,
    (() => {
      const workspaces = new WorkspaceCatalog(paths);
      return () => workspaces;
    })(),
  );
  t.after(() => {
    sessions.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const tools = new ToolRegistry();
  const ctx = new Context();
  ctx.provide('harnessTools', tools.service());
  ctx.provide('harnessModels', {
    list: () => [],
    register: () => () => {},
    available: async () => [],
    resolve: (choice) => choice,
    capabilities: (choice) => ({
      id: model.id,
      name: 'Fixture',
      input: choice.id === 'text-only' ? ['text'] : ['text', 'image'],
      contextWindow: 32000,
      maxTokens: 1024,
      reasoning: true,
      thinkingLevels: thinkingLevels(choice.id),
    }),
  });
  ctx.provide('harnessLlm', { ...llm, register: () => () => {}, select: () => undefined });
  ctx.provide('harnessToolExecutor', executor);
  ctx.provide('harnessCompaction', { ...basicCompaction, shouldCompact: () => false });
  ctx.provide('harnessPrompt', { build: async () => 'Fixture', register: () => () => {} });
  if (retryModel) ctx.on('agent/model-retry', retryModel);
  ctx.provide('harnessAgent', new AgentLoop(() => 8));
  const agent = new SessionRun(sessions);
  const record = sessions.create();
  return { agent, ctx, sessions, tools, record };
}

function queueInput(
  ctx: Context,
  sessions: SessionRegistry,
  id: string,
  text: string,
  mode: InboxItem['mode'],
  attachments?: Attachment[],
  options?: Pick<InboxItem, 'model' | 'thinkingLevel'>,
) {
  return new Inbox(sessions.log(id)).enqueue(
    mode,
    () => sessions.prepareInput(id, text, attachments),
    ctx.harnessModels,
    options,
  );
}

test('an alternative executor owns the model protocol and executes without the registered implementation', async (t) => {
  let requests = 0,
    executions = 0;
  const { agent, ctx, tools, record, sessions } = fixture(
    t,
    {
      async *stream(request) {
        assert.match(request.systemPrompt, /custom protocol/);
        assert.equal(request.tools, undefined);
        yield { type: 'done', message: requests++ === 0 ? answer('call change') : answer() };
      },
    },
    undefined,
    undefined,
    {
      ...nativeExecutor,
      present: (content, tools) => ({
        ...content,
        systemPrompt: content.systemPrompt + ' custom protocol: ' + tools.map((tool) => tool.name).join(', '),
      }),
      interpret: (message) =>
        message.content.some((part) => part.type === 'text' && part.text === 'call change')
          ? toolsAnswer(call('custom-call', 'change'))
          : message,
      async execute(calls, _tools, execution) {
        for (const call of calls) {
          assert.equal(execution.start?.(call), undefined);
          await execution.deliver(
            {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: 'changed externally' }],
              timestamp: Date.now(),
              isError: false,
            },
            execution.signal,
          );
        }
      },
    },
  );
  tools.register(
    defineTool({
      name: 'change',
      description: 'Change',
      parameters: Type.Object({}),
      async execute() {
        executions++;
        return { content: [{ type: 'text', text: 'changed' }] };
      },
    }),
  );
  await agent.prompt(ctx, record, 'Change it', () => {}, {
    fallback: model,
    signal: new AbortController().signal,
  });
  assert.equal(executions, 0);
  assert.equal(requests, 2);
  assert.ok(
    sessions
      .log(record.id)
      .projection()
      .contextMessages.some(
        (message) => message.role === 'toolResult' && message.toolCallId === 'custom-call',
      ),
  );
});

test('duplicate tool call identities fail before executing any side effect', async (t) => {
  let requests = 0,
    executions = 0;
  const { agent, ctx, tools, record } = fixture(t, {
    async *stream() {
      yield {
        type: 'done',
        message:
          requests++ === 0 ? toolsAnswer(call('duplicate', 'change'), call('duplicate', 'change')) : answer(),
      };
    },
  });
  tools.register(
    defineTool({
      name: 'change',
      description: 'Change',
      parameters: Type.Object({}),
      async execute() {
        executions++;
        return { content: [{ type: 'text', text: 'changed' }] };
      },
    }),
  );
  await assert.rejects(
    agent.prompt(ctx, record, 'Change it', () => {}, {
      fallback: model,
      signal: new AbortController().signal,
    }),
    /duplicate.*tool|tool.*duplicate/i,
  );
  assert.equal(executions, 0);
});

test('tool execution uses the advertised registration and does not execute a hot replacement', async (t) => {
  let requests = 0,
    executions = 0;
  let replace: () => Promise<void>;
  const { agent, ctx, tools, record, sessions } = fixture(t, {
    async *stream() {
      if (requests++ === 0) {
        await replace();
        yield { type: 'done', message: toolsAnswer(call('first-call', 'change')) };
      } else yield { type: 'done', message: answer() };
    },
  });
  const dispose = tools.register(
    defineTool({
      name: 'change',
      description: 'Original',
      parameters: Type.Object({}),
      async execute() {
        executions++;
        return { content: [{ type: 'text', text: 'original' }] };
      },
    }),
  );
  replace = async () => {
    await dispose();
    tools.register(
      defineTool({
        name: 'change',
        description: 'Replacement',
        parameters: Type.Object({}),
        async execute() {
          executions++;
          return { content: [{ type: 'text', text: 'replacement' }] };
        },
      }),
    );
  };
  await agent.prompt(ctx, record, 'Change it', () => {}, {
    fallback: model,
    signal: new AbortController().signal,
  });
  assert.equal(executions, 0);
  assert.equal(
    sessions
      .log(record.id)
      .projection()
      .timeline.filter(isViewMessage)
      .find((message) => message.role === 'toolResult')?.isError,
    true,
  );
});

test('malformed tool arguments become durable error results without invoking the tool', async (t) => {
  let requests = 0,
    executions = 0;
  const { agent, ctx, tools, record, sessions } = fixture(t, {
    async *stream(request) {
      if (requests++ === 0)
        yield { type: 'done', message: toolsAnswer(call('invalid-call', 'inspect', { path: 42 })) };
      else {
        assert.equal(request.messages.at(-1)?.role, 'toolResult');
        assert.equal((request.messages.at(-1) as { isError: boolean }).isError, true);
        yield { type: 'done', message: answer('Recovered') };
      }
    },
  });
  tools.register(
    defineTool({
      name: 'inspect',
      description: 'Inspect',
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        executions++;
        return { content: [] };
      },
    }),
  );
  assert.equal(
    await agent.prompt(ctx, record, 'Inspect', () => {}, {
      fallback: model,
      signal: new AbortController().signal,
    }),
    'Recovered',
  );
  assert.equal(executions, 0);
  assert.equal(
    sessions
      .log(record.id)
      .projection()
      .timeline.filter(isViewMessage)
      .filter((message) => message.role === 'toolResult').length,
    1,
  );
});

test('cancellation closes the whole tool batch durably and never executes later tools', async (t) => {
  const controller = new AbortController();
  let ranFirst = 0,
    ranSecond = 0;
  const { agent, ctx, tools, record, sessions } = fixture(t, {
    async *stream() {
      yield { type: 'done', message: toolsAnswer(call('one', 'first'), call('two', 'second')) };
    },
  });
  tools.register(
    defineTool({
      name: 'first',
      description: 'First',
      parameters: Type.Object({}),
      async execute(_id, _args, signal) {
        ranFirst++;
        controller.abort(new Error('Stopped by test'));
        signal?.throwIfAborted();
        return { content: [] };
      },
    }),
  );
  tools.register(
    defineTool({
      name: 'second',
      description: 'Second',
      parameters: Type.Object({}),
      async execute() {
        ranSecond++;
        return { content: [] };
      },
    }),
  );
  const events: AgentEvent[] = [];
  await assert.rejects(
    agent.prompt(ctx, record, 'Run tools', (event) => events.push(event), {
      fallback: model,
      signal: controller.signal,
    }),
    /Stopped by test/,
  );
  const results = sessions
    .log(record.id)
    .projection()
    .timeline.filter(isViewMessage)
    .filter((message) => message.role === 'toolResult');
  assert.equal(ranFirst, 1);
  assert.equal(ranSecond, 0);
  assert.deepEqual(
    results.map(({ toolCallId, isError, toolState }) => [toolCallId, isError, toolState]),
    [
      ['one', true, 'cancelled'],
      ['two', true, 'skipped'],
    ],
  );
  assert.deepEqual(
    events.flatMap((event) => (event.type === 'tool-end' ? [event.message.toolState] : [])),
    ['cancelled', 'skipped'],
  );
});

test('a concurrent cancellation does not hide a genuine tool failure', async () => {
  const controller = new AbortController();
  const tool = defineTool({
    name: 'fail',
    description: 'Fail independently of cancellation',
    parameters: Type.Object({}),
    async execute() {
      controller.abort(new Error('Stopped by test'));
      throw new Error('Independent failure');
    },
  });
  const states: string[] = [];
  await nativeExecutor.execute([call('one', 'fail'), call('two', 'fail')], new Map([[tool.name, tool]]), {
    signal: controller.signal,
    async deliver(result) {
      states.push(toolResultState(result));
    },
  });
  assert.deepEqual(states, ['error', 'skipped']);
});

test('interrupted calls receive an error record before the next prompt and are not retried', async (t) => {
  let executed = 0;
  const { agent, ctx, tools, record, sessions } = fixture(t, {
    async *stream(request) {
      const results = request.messages.filter((message) => message.role === 'toolResult');
      assert.equal(results.length, 1);
      assert.equal(results[0].isError, true);
      yield { type: 'done', message: answer() };
    },
  });
  tools.register(
    defineTool({
      name: 'change',
      description: 'Change',
      parameters: Type.Object({}),
      async execute() {
        executed++;
        return { content: [] };
      },
    }),
  );
  sessions.log(record.id).append({ type: 'message', message: toolsAnswer(call('interrupted', 'change')) });
  await agent.prompt(ctx, record, 'Continue', () => {}, {
    fallback: model,
    signal: new AbortController().signal,
  });
  assert.equal(executed, 0);
});

test('identical queued text preserves each attachment identity and is delivered exactly once', async (t) => {
  let entered: () => void = () => {
    throw new Error('Not started');
  };
  let release: () => void = () => {
    throw new Error('Not started');
  };
  let requests = 0;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const { agent, ctx, record, sessions } = fixture(t, {
    async *stream() {
      if (requests++ === 0) {
        entered();
        await hold;
      }
      yield { type: 'done', message: answer() };
    },
  });
  const run = agent.prompt(ctx, record, 'Initial', () => {}, {
    fallback: model,
    signal: new AbortController().signal,
  });
  await ready;
  const data = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  await queueInput(ctx, sessions, record.id, 'Same text', 'followUp', [
    { name: 'first.png', mimeType: 'image/png', data },
  ]);
  await queueInput(ctx, sessions, record.id, 'Same text', 'followUp', [
    { name: 'second.png', mimeType: 'image/png', data },
  ]);
  release();
  await run;
  const users = sessions
    .log(record.id)
    .projection()
    .timeline.filter(isViewMessage)
    .filter((message) => message.role === 'user');
  assert.equal(requests, 3);
  assert.equal(users.length, 3);
  assert.deepEqual(
    users.slice(1).map(({ attachments }) => expectPresent(attachments?.[0], 'queued attachment').name),
    ['first.png', 'second.png'],
  );
  const stored = users
    .slice(1)
    .map(({ attachments }) =>
      sessions
        .readAttachment(record.id, expectPresent(attachments?.[0]?.id, 'queued attachment identity'))
        ?.toString('base64'),
    );
  assert.deepEqual(stored, [data, data]);
  assert.deepEqual(sessions.log(record.id).queue(), []);
});

test('steering accepts off, skips deterministic failures and resets incompatible inherited thinking for a new model', async (t) => {
  let started = () => {};
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const levels: (string | undefined)[] = [];
  const events: AgentEvent[] = [];
  const { agent, ctx, sessions, record, tools } = fixture(
    t,
    {
      async *stream(request) {
        levels.push(request.thinkingLevel);
        if (levels.length === 1) {
          started();
          await hold;
          yield { type: 'done', message: toolsAnswer(call('steered-call', 'first')) };
        } else {
          if (levels.length === 2) {
            const result = request.messages.find((message) => message.role === 'toolResult');
            assert.equal(result?.isError, true);
            assert.match(JSON.stringify(result?.content), /steering message arrived/);
          }
          yield { type: 'done', message: answer() };
        }
      },
    },
    undefined,
    (id) => (id === 'new-model' ? ['low'] : ['low', 'medium', 'high', 'xhigh', 'max']),
  );
  tools.register(
    defineTool({
      name: 'first',
      description: 'Should be skipped',
      parameters: Type.Object({}),
      async execute() {
        events.push({ type: 'error', error: 'The skipped tool was executed' });
        return { content: [] };
      },
    }),
  );
  const run = agent.prompt(
    ctx,
    record,
    'Initial',
    (event) => {
      events.push(event);
    },
    {
      fallback: model,
      signal: new AbortController().signal,
      thinkingLevel: 'off',
    },
  );
  await ready;
  const log = sessions.log(record.id);
  log.append({
    type: 'inbox-enqueued',
    item: {
      id: 'stale-level',
      mode: 'steer',
      text: 'Stale instruction',
      images: [],
      model: { provider: model.provider, id: 'new-model' },
      thinkingLevel: 'high',
    },
  });
  await queueInput(ctx, sessions, record.id, 'Actual instruction', 'steer');
  await queueInput(ctx, sessions, record.id, 'Keep reasoning', 'followUp', undefined, {
    thinkingLevel: 'high',
  });
  await queueInput(ctx, sessions, record.id, 'Switch model', 'followUp', undefined, {
    model: { ...model, id: 'new-model' },
  });
  const queue = await queueInput(ctx, sessions, record.id, 'Cancel me', 'followUp');
  new Inbox(log).cancel(
    'User cancelled',
    expectPresent(
      queue.find(({ summary }) => summary === 'Cancel me'),
      'cancelled entry',
    ).id,
  );
  release();
  await run;
  assert.deepEqual(levels, ['off', 'off', 'high', undefined]);
  assert.ok(!events.some(({ type }) => type === 'error'));
  assert.deepEqual(
    events.flatMap((event) => (event.type === 'tool-end' ? [event.message.toolState] : [])),
    ['skipped'],
  );
  assert.equal(
    log
      .projection()
      .timeline.filter(isViewMessage)
      .find(({ toolCallId }) => toolCallId === 'steered-call')?.toolState,
    'skipped',
  );
  assert.deepEqual(log.inbox(), []);
  assert.deepEqual(
    log.queue().map(({ id, state }) => [id, state]),
    [['stale-level', 'failed']],
  );
  assert.ok(log.entries().some(({ type }) => type === 'inbox-cancelled'));
  assert.equal(log.entries().filter((entry) => entry.type === 'message' && entry.inboxId).length, 3);
});

test(
  'opted-in tools overlap, persist independently and respect serial barriers',
  { timeout: 5000 },
  async (t) => {
    let requests = 0;
    const { agent, ctx, tools, record, sessions } = fixture(t, {
      async *stream() {
        yield {
          type: 'done',
          message:
            requests++ === 0
              ? toolsAnswer(
                  call('before', 'serial'),
                  call('one', 'parallel', { wait: true }),
                  call('two', 'parallel', { wait: false }),
                  call('after', 'serial'),
                )
              : answer(),
        };
      },
    });
    const log = () =>
      sessions
        .log(record.id)
        .projection()
        .contextMessages.filter((message) => message.role === 'toolResult');
    const started: string[] = [];
    let release: () => void = () => {
      throw new Error('Not started');
    };
    const waitForDurability = new Promise<void>((resolve) => {
      release = resolve;
    });
    tools.register(
      defineTool({
        name: 'parallel',
        description: 'Parallel',
        parameters: Type.Object({ wait: Type.Boolean() }),
        isConcurrencySafe: ({ wait }) => typeof wait === 'boolean',
        async execute(id, { wait }, signal) {
          started.push(id);
          if (wait) {
            await Promise.race([
              waitForDurability,
              new Promise<never>((_, reject) =>
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
              ),
            ]);
          }
          return { content: [{ type: 'text', text: id }] };
        },
      }),
    );
    tools.register(
      defineTool({
        name: 'serial',
        description: 'Serial',
        parameters: Type.Object({}),
        async execute(id) {
          started.push(id);
          return { content: [] };
        },
      }),
    );
    const snapshots: string[][] = [];
    await agent.prompt(
      ctx,
      record,
      'Run batch',
      (event) => {
        if (event.type === 'tool-end' && event.message.toolState === 'finished') {
          snapshots.push(log().map(({ toolCallId }) => toolCallId));
          if (event.message.toolCallId === 'two') release();
        }
      },
      { fallback: model, signal: AbortSignal.timeout(3000) },
    );
    assert.deepEqual(started, ['before', 'one', 'two', 'after']);
    assert.deepEqual(snapshots, [
      ['before'],
      ['before', 'two'],
      ['before', 'two', 'one'],
      ['before', 'two', 'one', 'after'],
    ]);
  },
);

test('the retry policy cannot replay a model attempt after output has streamed', async (t) => {
  let requests = 0,
    retries = 0;
  const { agent, ctx, record } = fixture(
    t,
    {
      async *stream() {
        requests++;
        yield { type: 'text-delta', text: 'Partial' };
        throw new Error('Transport closed after output');
      },
    },
    async () => {
      retries++;
      return {};
    },
  );
  const deltas: string[] = [];
  await assert.rejects(
    agent.prompt(
      ctx,
      record,
      'Generate',
      (event) => {
        if (event.type === 'delta') deltas.push(event.text);
      },
      { fallback: model, signal: new AbortController().signal },
    ),
    /Transport closed after output/,
  );
  assert.deepEqual({ requests, retries, deltas }, { requests: 1, retries: 0, deltas: ['Partial'] });
});

test('a fatal pipeline failure stops dispatch and drains active calls', async () => {
  const tool = defineTool({
    name: 'parallel',
    description: 'Parallel',
    parameters: Type.Object({}),
    isConcurrencySafe: () => true,
    async execute() {
      return { content: [] };
    },
  });
  const tools = new Map([[tool.name, tool]]);
  const calls = Array.from({ length: 18 }, (_, index) => call(String(index), 'parallel'));
  const started: string[] = [];
  let drained = 0;
  await assert.rejects(
    nativeExecutor.execute(calls, tools, {
      signal: new AbortController().signal,
      start(call) {
        started.push(call.id);
        return undefined;
      },
      update() {},
      async deliver(result, signal) {
        if (result.toolCallId === '0') throw new Error('Log write failed');
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        drained++;
      },
    }),
    /Log write failed/,
  );
  assert.equal(started.length, 16);
  assert.equal(drained, 15);
});

test('a queued follow-up can preselect the next model and thinking level', async (t) => {
  let release: () => void = () => {
    throw new Error('Not started');
  };
  let entered: () => void = () => {
    throw new Error('Not started');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.after(() => release());
  const seen: { model: string; thinking: string }[] = [];
  const { agent, ctx, record, sessions } = fixture(t, {
    async *stream(request) {
      seen.push({ model: request.model.id, thinking: request.thinkingLevel ?? 'off' });
      if (seen.length === 1) {
        entered();
        await held;
      }
      yield { type: 'done', message: answer() };
    },
  });
  const pending = agent.prompt(ctx, record, 'Initial', () => {}, {
    fallback: model,
    signal: new AbortController().signal,
  });
  await started;
  await queueInput(ctx, sessions, record.id, 'Follow up', 'followUp', undefined, {
    model: { provider: 'fixture', id: 'next-model' },
    thinkingLevel: 'medium',
  });
  release();
  await pending;
  assert.deepEqual(seen, [
    { model: 'native', thinking: 'off' },
    { model: 'next-model', thinking: 'medium' },
  ]);
  assert.deepEqual(sessions.log(record.id).projection().model, { provider: 'fixture', id: 'next-model' });
  assert.deepEqual(sessions.log(record.id).inbox(), []);
});

test('text models see historical placeholders in the request and audit snapshot, while new images are rejected', async (t) => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const { agent, ctx, record, sessions } = fixture(t, {
    async *stream(request) {
      assert.match(JSON.stringify(request.messages), /Image unavailable to this model/);
      assert.doesNotMatch(JSON.stringify(request.messages), /iVBORw0KGgo=/);
      yield { type: 'done', message: answer() };
    },
  });
  const log = sessions.log(record.id);
  log.append({ type: 'message', message: { role: 'user', content: [image], timestamp: 1 } });
  const choice = { ...model, id: 'text-only' },
    signal = new AbortController().signal;
  await agent.prompt(ctx, record, 'Continue with text', () => {}, { signal, choice });
  const request = expectPresent(
    log.entries().find(({ type }) => type === 'model-request'),
    'recorded model request',
  );
  assert.doesNotMatch(JSON.stringify(log.requestSnapshot(request.id)), /iVBORw0KGgo=/);
  assert.match(JSON.stringify(log.requestSnapshot(request.id)), /Image unavailable/);
  assert.match(JSON.stringify(log.projection().timeline.filter(isViewMessage)), /iVBORw0KGgo=/);
  const previous = log.projection();
  await assert.rejects(
    agent.prompt(ctx, record, 'New image', () => {}, { signal, choice, images: [image] }),
    /does not support image/,
  );
  assert.deepEqual(log.projection(), previous);
});

test('native compaction reduces context and preserves message identities and history', async (t) => {
  const { app, mock, request } = await httpFixture(t);
  await app.runtime.configuration.update({
    entries: { 'core:compaction': { config: { autoCompact: false } } },
  });
  const { body: session } = await request('/sessions', 'POST', {});
  const compact = () => request('/sessions/' + session.id + '/compact', 'POST');
  const small = await compact();
  assert.equal(small.status, 400);
  assert.match(small.body.error, /Nothing to compact/);
  const log = app.runtime.plugins.ctx.harnessSessions.log(session.id);
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  log.append({ type: 'message', message: { role: 'user', content: [image], timestamp: 1 } });
  for (let turn = 0; turn < 6; turn++)
    await app.runtime.plugins.ctx.harnessRuns.send(
      session.id,
      'Turn ' + turn + ' ' + 'more context '.repeat(100),
    );
  const before = app.runtime.plugins.ctx.harnessSessions
    .log(session.id)
    .projection()
    .timeline.filter(isViewMessage);
  const compacted = await compact();
  assert.equal(compacted.status, 200, JSON.stringify(compacted.body));
  assert.equal(mock.requests.length, 7);
  assert.match(JSON.stringify(mock.requests.at(-1)), /Image unavailable/);
  assert.doesNotMatch(JSON.stringify(mock.requests.at(-1)), /iVBORw0KGgo=/);
  assert.ok(log.entries().some((entry) => entry.type === 'compaction'));
  assert.deepEqual(
    app.runtime.plugins.ctx.harnessSessions.log(session.id).projection().timeline.filter(isViewMessage),
    before,
  );
  assert.equal(log.projection().contextMessages.length, 5);
  assert.match(JSON.stringify(log.projection().contextMessages[0]), /Summary of earlier conversation/);
});

test('attachments enforce encoding, format and byte limits without creating files', () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGPUCIhigAEmBiSAmwMAKdYA2gR3lpgAAAAASUVORK5CYII=';
  const prepared = prepareInput('', [
    { name: 'one.png', mimeType: 'image/png', data: png },
    { name: 'notes.md', mimeType: 'text/plain', data: Buffer.from('An attached note').toString('base64') },
  ]);
  assert.equal(prepared.input.userText, '');
  assert.deepEqual(
    prepared.input.attachments.map(({ name, mimeType }) => ({ name, mimeType })),
    [
      { name: 'one.png', mimeType: 'image/png' },
      { name: 'notes.md', mimeType: 'text/plain' },
    ],
  );
  assert.deepEqual(
    prepared.files.map(({ id }) => id),
    prepared.input.attachments.map(({ id }) => id),
  );
  assert.equal(prepared.images.length, 1);
  assert.match(prepared.text, /An attached note/);
  assert.throws(
    () => prepareInput('a', [{ name: 'fake.png', mimeType: 'image/png', data: 'eA==' }]),
    /Invalid image/,
  );
  assert.throws(
    () => prepareInput('a', [{ name: 'b', mimeType: 'text/plain', data: '!!!' }]),
    /Invalid attachment/,
  );
  const binary = prepareInput('a', [
    { name: 'b.pdf', mimeType: 'application/pdf', data: Buffer.from([0, 1, 2]).toString('base64') },
  ]);
  assert.match(binary.text, /Uploaded file: "b.pdf"/);
  assert.deepEqual(binary.files[0].bytes, Buffer.from([0, 1, 2]));
  assert.throws(() => prepareInput('a', new Array(9).fill({})), /eight/);
});
