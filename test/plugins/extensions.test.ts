import { sendRun } from '../support/runs.ts';
import { isViewMessage } from '@mini-harness/sessions/message';
import { expectPresent } from '../support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../support/api-fixture.ts';

import { writePlugin } from '../support/plugin-fixture.ts';

test('prompt contributions coexist, override within a session tree and are removed with their plugins', async (t) => {
  const { app, paths, mock, request } = await fixture(t);
  writePlugin(
    paths.plugins,
    'app-prompt',
    {},
    `
export const inject = ["harnessPrompt"];
export const apply = (ctx) => {
    ctx.effect(() => ctx.harnessPrompt.register({ id: 'workspace-status', order: 600, render: () => '[App status]' }));
    ctx.effect(() => ctx.harnessPrompt.register({ id: 'base', order: 0, render: () => '[Custom base]' }));
    ctx.effect(() => ctx.harnessPrompt.register({ id: 'plan', order: 500, render: async ({ tools }) => tools.some(({ name }) => name === 'load_skill') ? '[Plan]' : undefined }));
  };
`,
  );
  writePlugin(
    paths.plugins,
    'more-prompt',
    {},
    `
export const inject = ["harnessPrompt"];
export const apply = (ctx) => {
    ctx.effect(() => ctx.harnessPrompt.register({ id: 'extra', order: 550, render: () => '[Extra]' }));
  };
`,
  );
  writePlugin(
    paths.plugins,
    'child-prompt',
    {},
    `
export const inject = ["harnessPrompt"];
export const apply = (ctx) => {
    ctx.effect(() => ctx.harnessPrompt.register({ id: 'workspace-status', order: 600, render: () => '[Child status]' }));
  };
`,
  );
  const parent = app.runtime.plugins.ctx.harnessSessions.create();
  const child = app.runtime.plugins.ctx.harnessSessions.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessSessions.create();
  async function prompt(id: string) {
    await sendRun(app.runtime.plugins.ctx.harnessRuns, id, 'Continue');
    const request = expectPresent(mock.requests.at(-1), 'recorded model request');
    const system = (request.messages as { role: string; content: string }[]).find(
      ({ role }) => role === 'system',
    );
    return expectPresent(system, 'system message').content;
  }
  const configured = await request('/settings', 'PATCH', {
    entries: {
      'app-prompt': { name: '../../plugins/app-prompt', disabled: false },
      'more-prompt': { name: '../../plugins/more-prompt', disabled: false },
    },
    scopes: {
      ['session:' + parent.id]: {
        entries: { 'child-prompt': { name: '../../plugins/child-prompt', disabled: false } },
      },
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.match(await prompt(child.id), /\[Plan\]\s+\[Extra\]\s+\[Child status\]/);
  const siblingPrompt = await prompt(sibling.id);
  assert.match(siblingPrompt, /\[Plan\]\s+\[Extra\]\s+\[App status\]/);
  assert.match(siblingPrompt, /^\[Custom base\]/);
  assert.doesNotMatch(siblingPrompt, /You are mini-harness/);
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: { 'more-prompt': { name: '../../plugins/more-prompt', disabled: true } },
        scopes: {},
      })
    ).status,
    200,
  );
  assert.match(await prompt(child.id), /\[Plan\]\s+\[App status\]/);
});

test('input contributions run at delivery in stable order and keep the submitted text', async (t) => {
  const { app, paths, mock, request } = await fixture(t, ({ messages }) => {
    const text = messages.at(-1)?.content;
    appendFileSync(join(paths.home, 'inputs.log'), 'model ' + text + '\n');
    return 'Done';
  });
  const trace = join(paths.home, 'inputs.log');
  writePlugin(
    paths.plugins,
    'input-z',
    {},
    `
import { appendFileSync } from 'node:fs';
export const provide = ['inputTransform'];
export const apply = (ctx) => {
      ctx.provide('inputTransform', true);
      ctx.on("agent/prepare-input", (content, { original }) => {
        appendFileSync(${JSON.stringify(trace)}, 'prepare ' + original.userText + '\\n');
        if (original.userText === 'Blocked') throw new Error('fixture input denied');
        return [...content, { type: 'text', text: '[z]' }];
      });
    };
`,
  );
  writePlugin(
    paths.plugins,
    'input-a',
    {},
    `
export const inject = ['inputTransform'];
export const apply = (ctx) => {
      ctx.on("agent/prepare-input", (content) => [...content, { type: 'text', text: '[a]' }]);
    };
`,
  );
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: {
          'input-z': { name: '../../plugins/input-z', disabled: false },
          'input-a': { name: '../../plugins/input-a', disabled: false },
        },
      })
    ).status,
    200,
  );
  const { plugins } = app.runtime;
  const registry = plugins.ctx.harnessSessions;
  const session = registry.create();
  const log = registry.log(session.id);
  log.append({
    type: 'inbox-enqueued',
    item: { id: 'blocked', mode: 'queue', text: 'Blocked', images: [] },
  });
  log.append({
    type: 'inbox-enqueued',
    item: { id: 'recovered', mode: 'queue', text: 'Recovered', images: [] },
  });
  await sendRun(plugins.ctx.harnessRuns, session.id, 'Manual', undefined, { mode: 'queue' });
  await plugins.ctx.harnessRuns.current(session.id)?.result;
  assert.deepEqual(readFileSync(trace, 'utf8').trimEnd().split('\n'), [
    'prepare Blocked',
    'prepare Recovered',
    'model Recovered[z][a]',
    'prepare Manual',
    'model Manual[z][a]',
  ]);
  assert.equal(log.inbox().length, 0);
  assert.match(
    expectPresent(
      log.queue().find(({ id }) => id === 'blocked'),
      'rejected queue item',
    ).reason ?? '',
    /fixture input denied/,
  );
  const messages = log
    .projection()
    .timeline.filter(isViewMessage)
    .filter(({ role }) => role === 'user');
  assert.deepEqual(
    messages.map(({ content }) => content),
    ['Recovered', 'Manual'],
  );

  const edit = await plugins.ctx.harnessRuns.reviseAndStart(session.id, {
    sourceEntryId: expectPresent(messages.at(-1)?.id, 'edited message'),
    expectedLeafId: log.projection().leafId,
    message: 'Edited',
  });
  await plugins.ctx.harnessRuns.current(edit.sessionId)?.result;
  assert.match(readFileSync(trace, 'utf8'), /prepare Edited\nmodel Edited\[z\]\[a\]\n$/);
  const before = mock.requests.length;
  await assert.rejects(sendRun(plugins.ctx.harnessRuns, session.id, 'Blocked'), /fixture input denied/);
  assert.equal(mock.requests.length, before);
  assert.doesNotMatch(JSON.stringify(log.projection().timeline.filter(isViewMessage)), /Blocked|lost|Manual/);
});

test('an application plugin registers an LLM adapter and composes execution hooks without rewriting history', async (t) => {
  const { app, paths, request, mock, base, headers } = await fixture(t);
  writePlugin(
    paths.plugins,
    'transport',
    {},
    `
export const inject = ["harnessLlm", "harnessModels"];
export const apply = (ctx) => {
    let attempts = 0;
    const modelCatalog = ctx.harnessModels;
    ctx.effect(() => ctx.harnessLlm.register({
    accepts: (choice) => choice.provider === 'local-mock',
    async *stream(request) {
      if (!modelCatalog.resolve(request.model)) throw new Error('missing catalog');
      const terminal = (content, stopReason = 'stop') => ({ type: 'done', message: { role: 'assistant', timestamp: Date.now(), content, stopReason } });
      if (++attempts === 1) throw new Error('transient transport failure');
      if (attempts === 2) {
        if (!request.systemPrompt.endsWith('[first][second]') || request.messages.at(-1).content[0]?.text !== 'Temporary context')
          throw new Error('waterfall did not compose');
        yield terminal([
          { type: 'toolCall', id: 'denied', name: 'check', arguments: { mode: 'denied' } },
          { type: 'toolCall', id: 'allowed', name: 'check', arguments: { mode: 'allowed' } }
        ], 'toolUse');
      } else {
        const tools = request.messages.filter(({ role }) => role === 'toolResult');
        if (tools.length !== 2 || tools[0].state === 'finished' || tools[1].content[0].text !== 'Value transformed')
          throw new Error('tool policy or result waterfall failed');
        yield terminal([{ type: 'text', text: 'Alternate response' }]);
      }
    } }));
  };
`,
  );
  writePlugin(
    paths.plugins,
    'pipeline',
    {},
    `
export const inject = ["harnessTools"];
export const apply = (ctx) => {
    ctx.on("agent/model-request", (request) => ({ ...request, systemPrompt: request.systemPrompt + '[second]' }));
    ctx.on("agent/model-request", (request, { turn }) => turn === 1 ? ({
      ...request, systemPrompt: request.systemPrompt + '[first]',
      messages: [...request.messages, { role: 'user', content: [{ type: 'text', text: 'Temporary context' }], timestamp: Date.now() }]
    }) : undefined, { prepend: true });
    ctx.on("agent/model-retry", ({ error, attempt }) => error === 'transient transport failure' && attempt === 1 ? {} : undefined);
    ctx.effect(() => ctx.harnessTools.register({ name: 'check', description: 'Check mode', parameters: { type: 'object' },
      async execute({ mode }) {
        if (mode !== 'allowed') throw new Error('denied input');
        return { state: 'finished', content: [{ type: 'text', text: 'Value' }] };
      }
    }));
    ctx.on("agent/tool-result", (content, { tool }) => tool === 'check'
      ? [{ type: 'text', text: content[0].text + ' transformed' }] : undefined);
    ctx.on("conversation/tool-projection", ({ content, tool }) =>
      tool === 'check' && Array.isArray(content) && content[0]?.text === 'Value transformed'
        ? [{ type: 'text', text: 'Display value' }] : undefined);
  };
`,
  );
  const { harnessModels: models, harnessModelStore: store } = app.runtime.plugins.ctx;
  const configured = await request('/settings', 'PATCH', {
    entries: {
      transport: { name: '../../plugins/transport', disabled: false },
      pipeline: { name: '../../plugins/pipeline', disabled: false },
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.deepEqual(app.runtime.plugins.ctx.harnessModels.list(), models.list());
  assert.equal(app.runtime.plugins.ctx.harnessModelStore, store);
  const session = app.runtime.plugins.ctx.harnessSessions.create();
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, session.id, 'Use the alternate LLM'),
    'Alternate response',
  );
  const log = app.runtime.plugins.ctx.harnessSessions.log(session.id).projection();
  assert.equal(log.contextMessages.filter(({ role }) => role === 'user').length, 1);
  const sessionLog = app.runtime.plugins.ctx.harnessSessions.log(session.id);
  const visible = await request('/sessions/' + session.id);
  assert.match(JSON.stringify(visible.body.timeline), /Display value/);
  assert.doesNotMatch(JSON.stringify(log), /Display value/);
  const run = expectPresent(app.runtime.plugins.ctx.harnessRuns.info(session.id), 'completed run');
  const replay = await fetch(base + '/api/sessions/' + session.id + '/events?run=' + run.id, { headers });
  assert.match(await replay.text(), /Display value/);
  const requests = sessionLog.entries().filter((entry) => entry.type === 'model-request');
  assert.equal(requests.length, 2);
  assert.match(requests[0].request.systemPrompt, /\[first\]\[second\]$/);
  assert.deepEqual(
    expectPresent(
      expectPresent(requests[0].request.messagesPatch, 'transformed message patch').insert.at(-1),
      'transformed message',
    ).content,
    [{ type: 'text', text: 'Temporary context' }],
  );
  assert.equal(requests[1].request.messagesPatch, undefined);
  assert.deepEqual(
    expectPresent(sessionLog.requestSnapshot(requests[0].id).messages.at(-1), 'model input message').content,
    [{ type: 'text', text: 'Temporary context' }],
  );
  assert.equal(
    expectPresent(sessionLog.requestSnapshot(requests[1].id).messages.at(-1), 'model tool result').role,
    'toolResult',
  );
  assert.equal(sessionLog.entries().filter((entry) => entry.type === 'tool-schema').length, 1);
  assert.equal(
    expectPresent(
      sessionLog.projection(requests[1].parentId).contextMessages.at(-1),
      'projection tool result',
    ).role,
    'toolResult',
  );
  assert.deepEqual(
    log.contextMessages
      .filter((message) => message.role === 'toolResult')
      .map(({ toolCallId, state }) => [toolCallId, state]),
    [
      ['denied', 'denied'],
      ['allowed', 'finished'],
    ],
  );
  assert.equal(mock.requests.length, 0);
  const execution = sessionLog.entries().find((entry) => entry.type === 'tool-execution');
  const accepted = sessionLog.entries().find((entry) => entry.type === 'tool-accepted');
  assert.ok(execution && accepted);
  assert.equal(accepted.executionId, execution.id);
  assert.ok(JSON.stringify(accepted).length < JSON.stringify(execution).length);
  const removed = await request('/settings', 'PATCH', {
    entries: {
      transport: { name: '../../plugins/transport', disabled: true },
      pipeline: { name: '../../plugins/pipeline', disabled: true },
    },
  });
  assert.equal(removed.status, 200);
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, session.id, 'Restore the built-in LLM'),
    'Mock response',
  );
});

test('a failed model-visible transform preserves the execution and never sends the raw result', async (t) => {
  const { app, paths, mock, request } = await fixture(t, () => ({ tool: 'sensitive', args: {} }));
  writePlugin(
    paths.plugins,
    'redaction',
    {},
    `
export const inject = ["harnessTools"];
export const apply = (ctx) => {
    ctx.effect(() => ctx.harnessTools.register({ name: 'sensitive', description: 'Read value', parameters: { type: 'object' },
      async execute(_args, { update }) {
        update({ content: [{ type: 'text', text: 'private progress' }] });
        return { state: 'finished', content: [{ type: 'text', text: 'private value' }] };
      }
    }));
    ctx.on("agent/tool-result", (content, { tool }) => {
      if (tool === 'sensitive') throw new Error('broken redactor');
      return content;
    });
  };
`,
  );
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: { redaction: { name: '../../plugins/redaction', disabled: false } },
      })
    ).status,
    200,
  );
  const session = app.runtime.plugins.ctx.harnessSessions.create();
  const events: unknown[] = [];
  await assert.rejects(
    sendRun(app.runtime.plugins.ctx.harnessRuns, session.id, 'Use the tool', (event) => events.push(event)),
    /Could not transform/,
  );
  const log = app.runtime.plugins.ctx.harnessSessions.log(session.id);
  assert.equal(mock.requests.length, 1);
  assert.equal(log.entries().filter((entry) => entry.type === 'tool-execution').length, 1);
  assert.match(
    JSON.stringify(log.entries().find((entry) => entry.type === 'tool-execution')),
    /private value/,
  );
  assert.doesNotMatch(JSON.stringify({ events, projection: log.projection() }), /private (value|progress)/);
  assert.match(JSON.stringify(log.projection().contextMessages.at(-1)), /transformation failed/);
});

test('an invalid transformed request fails before the provider is invoked', async (t) => {
  const { app, paths, mock, request } = await fixture(t);
  writePlugin(
    paths.plugins,
    'invalid-request',
    {},
    `
export const apply = (ctx) => {
    ctx.on("agent/model-request", (request) => ({ ...request, messages: [{ role: 'toolResult', toolCallId: 'missing',
      toolName: 'example', timestamp: Date.now(), state: 'finished', content: [] }] }));
  };
`,
  );
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: { 'invalid-request': { name: '../../plugins/invalid-request', disabled: false } },
      })
    ).status,
    200,
  );
  const session = app.runtime.plugins.ctx.harnessSessions.create();
  await assert.rejects(
    sendRun(app.runtime.plugins.ctx.harnessRuns, session.id, 'Use this request'),
    /Unmatched model request tool result/,
  );
  assert.equal(mock.requests.length, 0);
  assert.equal(
    app.runtime.plugins.ctx.harnessSessions
      .log(session.id)
      .entries()
      .some((entry) => entry.type === 'model-request'),
    false,
  );
});

test('unloading a request hook signals cancellation and waits for cleanup', { timeout: 5000 }, async (t) => {
  const { app, paths, request } = await fixture(t);
  const key = Symbol.for('mini-harness-test-hook-drain');
  let entered: () => void = () => {
    throw new Error('Not started');
  };
  let cancelled: () => void = () => {
    throw new Error('Not started');
  };
  let release: () => void = () => {
    throw new Error('Not started');
  };
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const state = { entered, cancelled, hold, cleaned: false };
  const shared = globalThis as typeof globalThis & Record<symbol, typeof state>;
  shared[key] = state;
  t.after(() => {
    release();
    delete shared[key];
  });
  writePlugin(
    paths.plugins,
    'slow-transform',
    {},
    `
export const apply = (ctx) => {
    const state = globalThis[Symbol.for('mini-harness-test-hook-drain')];
    ctx.on("agent/model-request", async (_request, { signal }) => {
      signal.addEventListener('abort', state.cancelled, { once: true });
      state.entered();
      await state.hold;
    });
    ctx.effect(() => () => { state.cleaned = true; });
  };
`,
  );
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: { 'slow-transform': { name: '../../plugins/slow-transform', disabled: false } },
      })
    ).status,
    200,
  );
  const session = app.runtime.plugins.ctx.harnessSessions.create();
  const run = assert.rejects(
    sendRun(app.runtime.plugins.ctx.harnessRuns, session.id, 'Unload the active hook'),
    /slow-transform could not prepare transformed data/,
  );
  await started;
  const updating = request('/settings', 'PATCH', {
    entries: { 'slow-transform': { name: '../../plugins/slow-transform', disabled: true } },
  });
  try {
    await aborted;
    assert.equal(state.cleaned, false);
  } finally {
    release();
  }
  assert.equal((await updating).status, 200);
  await run;
  assert.equal(state.cleaned, true);
});

test('Web runs with an independent model contribution and no Pi model store', async (t) => {
  const { app, paths, request } = await fixture(t);
  writePlugin(
    paths.plugins,
    'independent-model',
    {},
    `
export const inject = ['harnessModels', 'harnessLlm'];
export function apply(ctx) {
  const resolve = (choice) => choice.provider === 'local-fixture'
    ? { provider: 'local-fixture', id: choice.id || 'one' }
    : undefined;
  ctx.effect(() => ctx.harnessModels.register({
    list: () => [{ provider: 'local-fixture', id: 'one', name: 'One', configured: true, thinkingLevels: [], input: ['text'] }],
    resolve,
    capabilities: (choice) => ({ ...choice, name: choice.id, input: ['text'], contextWindow: 32000, maxTokens: 1024, reasoning: false }),
  }, {
    accepts: (choice) => choice.provider === 'local-fixture',
    async *stream() {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'Independent response' }], timestamp: Date.now() } };
    },
  }));
}
`,
  );
  const configured = await request('/settings', 'PATCH', {
    entries: {
      'core:pi-adapter': { disabled: true },
      'core:models': { disabled: true },
      'core:fixture-model': { name: '../../plugins/independent-model', disabled: false },
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.ok(app.runtime.plugins.ctx.get('harnessModelStore'));
  const models = await request('/models');
  assert.equal(models.status, 200);
  assert.equal(models.body.canManageProviders, false);
  assert.deepEqual(models.body.protocols, []);
  assert.deepEqual((await request('/providers')).body, []);
  assert.equal((await request('/providers', 'PUT', {})).status, 503);
  assert.equal(
    (await request('/settings', 'PATCH', { entries: { 'core:model-store': { disabled: true } } })).status,
    200,
  );
  assert.equal(app.runtime.plugins.ctx.get('harnessModelStore'), undefined);
  assert.ok(models.body.models.some((model: { provider: string }) => model.provider === 'local-fixture'));
  const session = app.runtime.plugins.ctx.harnessSessions.create({ workspaceId: null });
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, session.id, 'Use a dynamic model', undefined, {
      model: { provider: 'local-fixture', id: 'dynamic' },
    }),
    'Independent response',
  );
});

test('model contributions select matching capabilities and transport, and reject equal-ranked conflicts', async (t) => {
  const { app, paths, request } = await fixture(t);
  const model = { provider: 'local-mock', id: app.runtime.plugins.ctx.harnessModelPreference.recent().id };
  const ctx = app.runtime.plugins.ctx;
  let catalogChanges = 0;
  t.after(
    ctx.on('models/catalog-changed', () => {
      catalogChanges++;
    }),
  );
  const plugin = (name: string, priority: number, input: string[]) =>
    writePlugin(
      paths.plugins,
      name,
      {},
      `
export const inject = ['harnessModels'];
export function apply(ctx) {
  const model = ${JSON.stringify(model)};
  const input = ${JSON.stringify(input)};
  const resolve = (choice) => choice.provider === model.provider && (!choice.id || choice.id === model.id) ? model : undefined;
  ctx.effect(() => ctx.harnessModels.register({
    list: () => [{ ...model, name: ${JSON.stringify(name)}, configured: true, input, thinkingLevels: [] }],
    resolve,
    capabilities: () => ({ id: model.id, name: ${JSON.stringify(name)}, input, contextWindow: 64000, maxTokens: 4096, reasoning: false }),
  }, {
    accepts: (choice) => Boolean(resolve(choice)),
    async *stream() {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(name)} }], timestamp: Date.now() } };
    },
  }, ${priority}));
}
`,
    );
  plugin('model-low', 0, ['text']);
  plugin('model-high', 1, ['text', 'image']);
  plugin('model-tie', 1, ['text']);
  const toggle = async (name: string, disabled: boolean) => {
    const response = await request('/settings', 'PATCH', {
      entries: { [name]: { name: '../../plugins/' + name, disabled } },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  const list = () =>
    ctx.harnessModels.list().filter(({ provider, id }) => provider === model.provider && id === model.id);
  const session = ctx.harnessSessions.create();
  await toggle('model-low', false);
  assert.equal(catalogChanges, 1);
  assert.equal(list()[0]?.name, 'model-low');
  assert.deepEqual(ctx.harnessModels.capabilities(model)?.input, ['text']);
  assert.equal(await sendRun(ctx.harnessRuns, session.id, 'Low priority', undefined, { model }), 'model-low');
  await toggle('model-high', false);
  assert.equal(list()[0]?.name, 'model-high');
  assert.deepEqual(ctx.harnessModels.capabilities(model)?.input, ['text', 'image']);
  assert.equal(
    await sendRun(ctx.harnessRuns, session.id, 'High priority', undefined, { model }),
    'model-high',
  );
  await toggle('model-tie', false);
  assert.deepEqual(list(), []);
  assert.equal(ctx.harnessModels.resolve(model), undefined);
  assert.equal(ctx.harnessModels.capabilities(model), undefined);
  assert.equal(ctx.harnessLlm.select(model), null);
  await assert.rejects(
    ctx.harnessLlm.stream(
      {
        model,
        messages: [],
        systemPrompt: '',
        signal: new AbortController().signal,
      },
      () => assert.fail('An ambiguous model must not stream'),
    ),
    /Multiple model adapters/,
  );
  await toggle('model-tie', true);
  assert.equal(list()[0]?.name, 'model-high');
  await toggle('model-high', true);
  assert.equal(list()[0]?.name, 'model-low');
  await toggle('model-low', true);
  assert.equal(
    await sendRun(ctx.harnessRuns, session.id, 'Restore Pi', undefined, { model }),
    'Mock response',
  );
  const adapter = {
    accepts: (choice: typeof model) => choice.provider === model.provider,
    async *stream() {
      assert.fail('Ambiguous adapter must not stream');
    },
  };
  const first = ctx.harnessLlm.register(adapter);
  const second = ctx.harnessLlm.register(adapter);
  try {
    assert.equal(ctx.harnessModels.resolve(model), undefined);
    assert.deepEqual(ctx.harnessModelPreference.recent(), { provider: '', id: '' });
  } finally {
    second();
    first();
  }
  assert.deepEqual(ctx.harnessModels.resolve(model), model);
  const before = catalogChanges;
  await ctx.harnessModelPreference.remember(model);
  await ctx.parallel('models/source-changed', 'auth');
  assert.equal(catalogChanges, before);

  const metadata = ctx.harnessModels.capabilities(model)!;
  const entries = list();
  const dispose = ctx.harnessModels.register(
    {
      list: () => entries,
      resolve: (choice) => (adapter.accepts(choice) ? model : undefined),
      capabilities: () => metadata,
    },
    adapter,
    10,
  );
  // Direct paired registration and release each publish once.
  assert.equal(catalogChanges, before + 1);
  dispose();
  assert.equal(catalogChanges, before + 2);

  // A source edit is committed while a candidate Profile graph is being activated.
  // The rejected Profile change must not discard the independent source notification.
  writePlugin(
    paths.plugins,
    'reject-model-update',
    {},
    `
export const inject = ['harnessModelStore'];
export async function apply(ctx) {
  await ctx.harnessModelStore.removeProvider({ id: 'local-mock' });
  throw new Error('Rejected graph');
}
`,
  );
  const rejected = await request('/settings', 'PATCH', {
    entries: { 'reject-model-update': { name: '../../plugins/reject-model-update', disabled: false } },
  });
  assert.equal(rejected.status, 400);
  assert.match(JSON.stringify(rejected.body), /Rejected graph/);
  assert.equal(ctx.harnessModels.resolve(model), undefined);
  assert.deepEqual(ctx.harnessModelPreference.recent(), { provider: '', id: '' });
});

test(
  'unloading a streaming adapter closes the iterator before its resources',
  { timeout: 5000 },
  async (t) => {
    const { app } = await fixture(t);
    const ctx = app.runtime.plugins.ctx;
    let enterCleanup!: () => void;
    let releaseCleanup!: () => void;
    const cleaning = new Promise<void>((resolve) => {
      enterCleanup = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let released = false;
    const model = { provider: 'stream-lifetime', id: 'test' };
    const fiber = ctx.inject(['harnessLlm'], (plugin) => {
      plugin.effect(() => () => {
        released = true;
      });
      plugin.effect(() =>
        plugin.harnessLlm.register({
          accepts: (choice) => choice.provider === model.provider,
          async *stream({ signal }) {
            try {
              yield { type: 'text-delta', text: 'partial' };
              signal.throwIfAborted();
              await new Promise<void>((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              });
            } finally {
              enterCleanup();
              await hold;
            }
          },
        }),
      );
    });
    await fiber;
    let received!: (event: unknown) => void;
    const firstEvent = new Promise<unknown>((resolve) => {
      received = resolve;
    });
    const settled = assert.rejects(
      ctx.harnessLlm.stream(
        { model, messages: [], systemPrompt: '', signal: new AbortController().signal },
        received,
      ),
      { name: 'AbortError' },
    );
    assert.deepEqual(await firstEvent, { type: 'text-delta', text: 'partial' });
    const unloading = fiber.dispose();
    try {
      await cleaning;
      assert.equal(released, false);
    } finally {
      releaseCleanup();
    }
    await unloading;
    assert.equal(released, true);
    await settled;
  },
);
