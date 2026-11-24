import { expectPresent } from '../support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../support/api-fixture.js';

import { writePlugin } from '../support/plugin-fixture.js';

test('prompt contributions coexist, override within a session tree and are removed with their plugins', async (t) => {
  const { app, paths, mock, request } = await fixture(t);
  writePlugin(paths.plugins, 'app-prompt', {}, `export default (_ctx, api) => {
    api.contribute(promptExtensions.section, { id: 'workspace-status', order: 600, render: () => '[App status]' });
    api.contribute(promptExtensions.section, { id: 'plan', order: 500, render: async ({ tools }) => tools.some(({ name }) => name === 'load_skill') ? '[Plan]' : undefined });
  };`);
  writePlugin(paths.plugins, 'more-prompt', {}, `export default (_ctx, api) => {
    api.contribute(promptExtensions.section, { id: 'extra', order: 550, render: () => '[Extra]' });
  };`);
  writePlugin(paths.plugins, 'child-prompt', { scope: 'session' }, `export default (_ctx, api) => {
    api.contribute(promptExtensions.section, { id: 'workspace-status', order: 600, render: () => '[Child status]' });
  };`);
  const parent = app.runtime.plugins.ctx.harnessRegistry.create();
  const child = app.runtime.plugins.ctx.harnessRegistry.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessRegistry.create();
  async function prompt(id: string) {
    await app.runtime.plugins.ctx.harnessRuns.send(id, 'Continue');
    const request = expectPresent(mock.requests.at(-1), 'recorded model request');
    const system = (request.messages as { role: string; content: string }[]).find(({ role }) => role === 'system');
    return expectPresent(system, 'system message').content;
  }
  const configured = await request('/settings', 'PATCH', {
    plugins: { 'app-prompt': true, 'more-prompt': true },
    scopes: { ['session:' + parent.id]: { plugins: { 'child-prompt': true } } }
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.match(await prompt(child.id), /\[Plan\]\s+\[Extra\]\s+\[Child status\]/);
  assert.match(await prompt(sibling.id), /\[Plan\]\s+\[Extra\]\s+\[App status\]/);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'more-prompt': false }, scopes: {} })).status, 200);
  assert.match(await prompt(child.id), /\[Plan\]\s+\[App status\]/);
});

test('input contributions run at delivery in stable order and keep the submitted text', async (t) => {
  const { app, paths, mock, request } = await fixture(t, ({ messages }) => {
    const text = messages.at(-1)?.content;
    appendFileSync(join(paths.home, 'inputs.log'), 'model ' + text + '\n');
    return 'Done';
  });
  const trace = join(paths.home, 'inputs.log');
  writePlugin(paths.plugins, 'input-z', {}, `
    import { appendFileSync } from 'node:fs';
    export default (_ctx, api) => {
      api.contribute(agentExtensions.prepareInput, (content, { original }) => {
        appendFileSync(${JSON.stringify(trace)}, 'prepare ' + original.userText + '\\n');
        if (original.userText === 'Blocked') return { reject: 'fixture input denied' };
        return [...content, { type: 'text', text: '[z]' }];
      });
    };`);
  writePlugin(paths.plugins, 'input-a', { requires: ['input-z'] }, `
    export default (_ctx, api) => {
      api.contribute(agentExtensions.prepareInput, (content, { original }) => {
        original.userText = 'lost';
        content[0].text = 'lost';
      });
      api.contribute(agentExtensions.prepareInput, (content) => [...content, { type: 'text', text: '[a]' }]);
    };`);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'input-z': true, 'input-a': true } })).status, 200);
  const { plugins } = app.runtime;
  const registry = plugins.ctx.harnessRegistry;
  const session = registry.create();
  const log = registry.log(session.id);
  log.append({ type: 'inbox-enqueued', item: { id: 'blocked', mode: 'followUp', text: 'Blocked', images: [] } });
  log.append({ type: 'inbox-enqueued', item: { id: 'recovered', mode: 'followUp', text: 'Recovered', images: [] } });
  await plugins.ctx.harnessRuns.send(session.id, 'Manual');
  assert.deepEqual(readFileSync(trace, 'utf8').trimEnd().split('\n'), [
    'prepare Blocked', 'prepare Recovered', 'model Recovered[a][z]', 'prepare Manual', 'model Manual[a][z]'
  ]);
  assert.equal(log.inbox().length, 0);
  assert.match(expectPresent(log.queue().find(({ id }) => id === 'blocked'), 'rejected queue item').reason ?? '', /fixture input denied/);
  const messages = log.projection().messages.filter(({ role }) => role === 'user');
  assert.deepEqual(messages.map(({ content }) => content), [
    [{ type: 'text', text: 'Recovered' }], [{ type: 'text', text: 'Manual' }]
  ]);

  const edit = await plugins.ctx.harnessRuns.reviseAndStart(session.id, {
    sourceEntryId: expectPresent(messages.at(-1)?.id, 'edited message'), expectedLeafId: log.projection().leafId, message: 'Edited'
  });
  await plugins.ctx.harnessRuns.completion(edit.sessionId);
  assert.match(readFileSync(trace, 'utf8'), /prepare Edited\nmodel Edited\[a\]\[z\]\n$/);
  const before = mock.requests.length;
  await assert.rejects(plugins.ctx.harnessRuns.send(session.id, 'Blocked'), /fixture input denied/);
  assert.equal(mock.requests.length, before);
  assert.doesNotMatch(JSON.stringify(log.projection().messages), /Blocked|lost|Manual/);
});

test('an application plugin replaces only LLM and composes execution hooks without rewriting history', async (t) => {
  const { app, paths, request, mock, base, headers } = await fixture(t);
  writePlugin(paths.plugins, 'transport', { provides: ['harnessLlm'], inject: ['harnessModels'] }, `export default (ctx, api) => {
    let attempts = 0;
    const modelCatalog = api.service('harnessModels');
    ctx.provide('harnessLlm', { async *stream(request) {
      if (!modelCatalog.resolve(request.model)) throw new Error('missing catalog');
      const terminal = (content, stopReason = 'stop') => ({ type: 'done', message: { role: 'assistant', timestamp: Date.now(), content, stopReason } });
      if (++attempts === 1) throw new Error('transient transport failure');
      if (attempts === 2) {
        if (!request.systemPrompt.endsWith('[first][second]') || request.messages.at(-1).content !== 'Temporary context')
          throw new Error('waterfall did not compose');
        yield terminal([
          { type: 'toolCall', id: 'denied', name: 'check', arguments: { mode: 'denied' } },
          { type: 'toolCall', id: 'allowed', name: 'check', arguments: { mode: 'allowed' } }
        ], 'toolUse');
      } else {
        const tools = request.messages.filter(({ role }) => role === 'toolResult');
        if (tools.length !== 2 || !tools[0].isError || tools[1].content[0].text !== 'Value transformed')
          throw new Error('tool policy or result waterfall failed');
        yield terminal([{ type: 'text', text: 'Alternate response' }]);
      }
    } });
  };`);
  writePlugin(paths.plugins, 'pipeline', { inject: ['harnessTools'] }, `export default (_ctx, api) => {
    api.contribute(agentExtensions.modelRequest, (request) => ({ ...request, systemPrompt: request.systemPrompt + '[second]' }), 2);
    api.contribute(agentExtensions.modelRequest, (request, { turn, phase }) => phase === 'turn' && turn === 1 ? ({
      ...request, systemPrompt: request.systemPrompt + '[first]',
      messages: [...request.messages, { role: 'user', content: 'Temporary context', timestamp: Date.now() }]
    }) : undefined, 1);
    api.contribute(agentExtensions.retryModel, ({ error, attempt }) => error === 'transient transport failure' && attempt === 1 ? {} : undefined);
    api.contribute(toolExtensions.decide, ({ tool, callId, arguments: args }) => tool === 'check' && callId === 'denied' && args.mode === 'denied' ? 'deny' : undefined);
    api.contribute(toolExtensions.register, { name: 'check', description: 'Check mode', parameters: { type: 'object' },
      async execute(_id, { mode }) {
        if (mode !== 'allowed') throw new Error('denied invocation ran');
        return { content: [{ type: 'text', text: 'Value' }] };
      }
    });
    api.contribute(agentExtensions.toolResult,  (content, { tool }) => tool === 'check'
      ? [{ type: 'text', text: content[0].text + ' transformed' }] : undefined);
    api.contribute(sessionDisplayExtensions.project, ({ content, tool }) =>
      tool === 'check' && Array.isArray(content) && content[0]?.text === 'Value transformed'
        ? [{ type: 'text', text: 'Display value' }] : undefined);
  };`);
  const { harnessModels: models, harnessModelStore: store } = app.runtime.plugins.ctx;
  const configured = await request('/settings', 'PATCH', {
    plugins: { 'core:llm': false, transport: true, pipeline: true }, providers: { harnessLlm: 'transport' }
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(app.runtime.plugins.ctx.harnessModels, models);
  assert.equal(app.runtime.plugins.ctx.harnessModelStore, store);
  const session = app.runtime.plugins.ctx.harnessRegistry.create();
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(session.id, 'Use the alternate LLM'), 'Alternate response');
  const log = app.runtime.plugins.ctx.harnessRegistry.log(session.id).projection();
  assert.equal(log.contextMessages.filter(({ role }) => role === 'user').length, 1);
  const sessionLog = app.runtime.plugins.ctx.harnessRegistry.log(session.id);
  const visible = await request('/sessions/' + session.id);
  assert.match(JSON.stringify(visible.body.messages), /Display value/);
  assert.doesNotMatch(JSON.stringify(log), /Display value/);
  const run = expectPresent(app.runtime.plugins.ctx.harnessRuns.info(session.id), 'completed run');
  const replay = await fetch(base + '/api/sessions/' + session.id + '/events?run=' + run.id, { headers });
  assert.match(await replay.text(), /Display value/);
  const requests = sessionLog.entries().filter((entry) => entry.type === 'model-request');
  assert.equal(requests.length, 2);
  assert.match(requests[0].request.systemPrompt, /\[first\]\[second\]$/);
  assert.equal(expectPresent(expectPresent(requests[0].request.messagesPatch, 'transformed message patch').insert.at(-1), 'transformed message').content, 'Temporary context');
  assert.equal(requests[1].request.messagesPatch, undefined);
  assert.equal(expectPresent(sessionLog.requestSnapshot(requests[0].id).messages.at(-1), 'model input message').content, 'Temporary context');
  assert.equal(expectPresent(sessionLog.requestSnapshot(requests[1].id).messages.at(-1), 'model tool result').role, 'toolResult');
  assert.equal(sessionLog.entries().filter((entry) => entry.type === 'tool-schema').length, 1);
  assert.equal(expectPresent(sessionLog.projection(requests[1].parentId).contextMessages.at(-1), 'projection tool result').role, 'toolResult');
  assert.deepEqual(log.contextMessages.filter((message) => message.role === 'toolResult').map(({ toolCallId, isError }) =>
    [toolCallId, isError]), [['denied', true], ['allowed', false]]);
  assert.equal(mock.requests.length, 0);
  const execution = sessionLog.entries().find((entry) => entry.type === 'tool-execution');
  const accepted = sessionLog.entries().find((entry) => entry.type === 'tool-accepted');
  assert.ok(execution && accepted);
  assert.equal(accepted.executionId, execution.id);
  assert.ok(JSON.stringify(accepted).length < JSON.stringify(execution).length);
  const missing = await request('/settings', 'PATCH', { plugins: { transport: false }, providers: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /harnessLlm/);
  assert.equal(app.runtime.settings.providers.harnessLlm, 'transport');
  assert.equal((await request('/settings', 'PATCH', {
    plugins: { 'core:llm': true, transport: false, pipeline: false }, providers: {}
  })).status, 200);
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(session.id, 'Restore the built-in LLM'), 'Mock response');
});

test('a failed model-visible transform preserves the execution and never sends the raw result', async (t) => {
  const { app, paths, mock, request } = await fixture(t, () => ({ tool: 'sensitive', args: {} }));
  writePlugin(paths.plugins, 'redaction', { inject: ['harnessTools'] }, `export default (_ctx, api) => {
    api.contribute(toolExtensions.register, { name: 'sensitive', description: 'Read value', parameters: { type: 'object' },
      async execute(_id, _args, _signal, update) {
        update({ content: [{ type: 'text', text: 'private progress' }] });
        return { content: [{ type: 'text', text: 'private value' }] };
      }
    });
    api.contribute(agentExtensions.toolResult, (content, { tool }) => {
      if (tool === 'sensitive') throw new Error('broken redactor');
      return content;
    });
  };`);
  assert.equal((await request('/settings', 'PATCH', { plugins: { redaction: true } })).status, 200);
  const session = app.runtime.plugins.ctx.harnessRegistry.create();
  const events: unknown[] = [];
  await assert.rejects(app.runtime.plugins.ctx.harnessRuns.send(session.id, 'Use the tool', (event) => events.push(event)), /Could not transform/);
  const log = app.runtime.plugins.ctx.harnessRegistry.log(session.id);
  assert.equal(mock.requests.length, 1);
  assert.equal(log.entries().filter((entry) => entry.type === 'tool-execution').length, 1);
  assert.match(JSON.stringify(log.entries().find((entry) => entry.type === 'tool-execution')), /private value/);
  assert.doesNotMatch(JSON.stringify({ events, projection: log.projection() }), /private (value|progress)/);
  assert.match(JSON.stringify(log.projection().contextMessages.at(-1)), /transformation failed/);
});

test('an invalid transformed request fails before the provider is invoked', async (t) => {
  const { app, paths, mock, request } = await fixture(t);
  writePlugin(paths.plugins, 'invalid-request', {}, `export default (_ctx, api) => {
    api.contribute(agentExtensions.modelRequest, (request) => ({ ...request, messages: [{ role: 'toolResult', toolCallId: 'missing',
      toolName: 'example', timestamp: Date.now(), isError: false, content: [] }] }));
  };`);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'invalid-request': true } })).status, 200);
  const session = app.runtime.plugins.ctx.harnessRegistry.create();
  await assert.rejects(app.runtime.plugins.ctx.harnessRuns.send(session.id, 'Use this request'), /could not prepare transformed data/);
  assert.equal(mock.requests.length, 0);
  assert.equal(app.runtime.plugins.ctx.harnessRegistry.log(session.id).entries().some((entry) => entry.type === 'model-request'), false);
});

test('configuration cannot unmount an active request hook and can retry after the run', { timeout: 5000 }, async (t) => {
  const { app, paths, request } = await fixture(t);
  const key = Symbol.for('mini-harness-test-hook-drain');
  let entered: () => void = () => { throw new Error('Not started'); };
  let cancelled: () => void = () => { throw new Error('Not started'); };
  let release: () => void = () => { throw new Error('Not started'); };
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let aborted = false;
  cancelled = () => { aborted = true; };
  const state = { entered, cancelled, hold, cleaned: false };
  const shared = globalThis as typeof globalThis & Record<symbol, typeof state>;
  shared[key] = state;
  t.after(() => { release(); delete shared[key]; });
  writePlugin(paths.plugins, 'slow-transform', {}, `export default (ctx, api) => {
    const state = globalThis[Symbol.for('mini-harness-test-hook-drain')];
    api.contribute(agentExtensions.modelRequest, async (_request, { signal }) => {
      signal.addEventListener('abort', state.cancelled, { once: true });
      state.entered();
      await state.hold;
    });
    ctx.effect(() => () => { state.cleaned = true; });
  };`);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'slow-transform': true } })).status, 200);
  const session = app.runtime.plugins.ctx.harnessRegistry.create();
  const run = app.runtime.plugins.ctx.harnessRuns.send(session.id, 'Keep the active hook');
  await started;
  try {
    assert.equal((await request('/settings', 'PATCH', { plugins: { 'slow-transform': false } })).status, 409);
    assert.equal(aborted, false);
    assert.equal(state.cleaned, false);
  } finally { release(); }
  await run;
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'slow-transform': false } })).status, 200);
  assert.equal(state.cleaned, true);
});

test('a decision hook can deny an inherited tool and is removed with its owner', async (t) => {
  const { app, paths, request } = await fixture(t);
  writePlugin(paths.plugins, 'policy', { scope: 'session' }, `
    export default function(_ctx, api) {
      api.contribute(toolExtensions.decide, async ({ tool, signal }) => {
        signal.throwIfAborted();
        return tool === 'ls' ? 'deny' : undefined;
      });
    }`);
  const selected = app.runtime.plugins.ctx.harnessRegistry.create();
  const other = app.runtime.plugins.ctx.harnessRegistry.create();
  const child = app.runtime.plugins.ctx.harnessRegistry.create({ parentId: selected.id });
  const toggle = (scopes: unknown) => request('/settings', 'PATCH', { scopes });
  assert.equal((await toggle({ ['session:' + selected.id]: { plugins: { policy: true } } })).status, 200);
  await app.runtime.plugins.prepare(`session:${child.id}`);
  const tools = app.runtime.plugins.ctx.harnessTools;
  const call = (id: string) => expectPresent(tools.forSession(id).find(({ name }) => name === 'ls'), 'ls tool')
    .execute('policy', { path: '.' }, undefined, undefined, undefined);
  await assert.rejects(call(child.id), /Tool denied by conversation or plugin policy/);
  assert.equal((await call(other.id)).content[0].type, 'text');
  assert.equal((await toggle({})).status, 200);
  assert.equal((await call(child.id)).content[0].type, 'text');
});
