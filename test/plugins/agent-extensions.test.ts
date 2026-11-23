import { expectPresent } from '../support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../support/api-fixture.js';

function plugin(directory: string, id: string, descriptor: object, source: string) {
  const folder = join(directory, id);
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify(descriptor));
  writeFileSync(join(folder, 'plugin.js'), source);
}

test('prompt contributions coexist, override within a session tree and are removed with their plugins', async (t) => {
  const { app, paths, mock, request } = await fixture(t);
  plugin(paths.plugins, 'app-prompt', {}, `export default (_ctx, api) => {
    api.promptSection({ id: 'workspace-status', order: 600, render: () => '[App status]' });
    api.promptSection({ id: 'plan', order: 500, render: async ({ tools }) => tools.some(({ name }) => name === 'load_skill') ? '[Plan]' : undefined });
  };`);
  plugin(paths.plugins, 'more-prompt', {}, `export default (_ctx, api) => {
    api.promptSection({ id: 'extra', order: 550, render: () => '[Extra]' });
  };`);
  plugin(paths.plugins, 'child-prompt', { scope: 'session' }, `export default (_ctx, api) => {
    api.promptSection({ id: 'workspace-status', order: 600, render: () => '[Child status]' });
  };`);
  const parent = app.runtime.registry.create();
  const child = app.runtime.registry.create({ parentId: parent.id });
  const sibling = app.runtime.registry.create();
  async function prompt(id: string) {
    await app.runtime.runs.send(id, 'Continue');
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

test('an application plugin replaces only LLM and composes execution hooks without rewriting history', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  plugin(paths.plugins, 'transport', { provides: ['harnessLlm'], inject: ['harnessModels'] }, `export default (_ctx, api) => {
    let attempts = 0;
    const modelCatalog = api.service('harnessModels');
    api.provide('harnessLlm', { async *stream(request) {
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
  plugin(paths.plugins, 'pipeline', { inject: ['harnessTools'] }, `export default (_ctx, api) => {
    api.modelRequest((request) => ({ ...request, systemPrompt: request.systemPrompt + '[second]' }), 2);
    api.modelRequest((request, { turn, phase }) => phase === 'turn' && turn === 1 ? ({
      ...request, systemPrompt: request.systemPrompt + '[first]',
      messages: [...request.messages, { role: 'user', content: 'Temporary context', timestamp: Date.now() }]
    }) : undefined, 1);
    api.retryModel(({ error, attempt }) => error === 'transient transport failure' && attempt === 1 ? {} : undefined);
    api.decideTool(({ tool, callId, arguments: args }) => tool === 'check' && callId === 'denied' && args.mode === 'denied' ? 'deny' : undefined);
    api.registerTool({ name: 'check', description: 'Check mode', parameters: { type: 'object' },
      async execute(_id, { mode }) {
        if (mode !== 'allowed') throw new Error('denied invocation ran');
        return { content: [{ type: 'text', text: 'Value' }] };
      }
    });
    api.toolResult( (content, { tool }) => tool === 'check'
      ? [{ type: 'text', text: content[0].text + ' transformed' }] : undefined);
  };`);
  const { harnessModels: models, harnessModelAdmin: admin } = app.runtime.plugins.ctx;
  const configured = await request('/settings', 'PATCH', {
    plugins: { transport: true, pipeline: true }, providers: { harnessLlm: 'transport' }
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(app.runtime.plugins.ctx.harnessModels, models);
  assert.equal(app.runtime.plugins.ctx.harnessModelAdmin, admin);
  const session = app.runtime.registry.create();
  assert.equal(await app.runtime.runs.send(session.id, 'Use the alternate LLM'), 'Alternate response');
  const log = app.runtime.registry.log(session.id).projection();
  assert.equal(log.contextMessages.filter(({ role }) => role === 'user').length, 1);
  const sessionLog = app.runtime.registry.log(session.id);
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
  assert.equal((await request('/settings', 'PATCH', { plugins: { transport: false, pipeline: false }, providers: {} })).status, 200);
  assert.equal(await app.runtime.runs.send(session.id, 'Restore the built-in LLM'), 'Mock response');
});

test('a failed model-visible transform preserves the execution and never sends the raw result', async (t) => {
  const { app, paths, mock, request } = await fixture(t, () => ({ tool: 'sensitive', args: {} }));
  plugin(paths.plugins, 'redaction', { inject: ['harnessTools'] }, `export default (_ctx, api) => {
    api.registerTool({ name: 'sensitive', description: 'Read value', parameters: { type: 'object' },
      async execute(_id, _args, _signal, update) {
        update({ content: [{ type: 'text', text: 'private progress' }] });
        return { content: [{ type: 'text', text: 'private value' }] };
      }
    });
    api.toolResult((content, { tool }) => {
      if (tool === 'sensitive') throw new Error('broken redactor');
      return content;
    });
  };`);
  assert.equal((await request('/settings', 'PATCH', { plugins: { redaction: true } })).status, 200);
  const session = app.runtime.registry.create();
  const events: unknown[] = [];
  await assert.rejects(app.runtime.runs.send(session.id, 'Use the tool', (event) => events.push(event)), /Could not transform/);
  const log = app.runtime.registry.log(session.id);
  assert.equal(mock.requests.length, 1);
  assert.equal(log.entries().filter((entry) => entry.type === 'tool-execution').length, 1);
  assert.match(JSON.stringify(log.entries().find((entry) => entry.type === 'tool-execution')), /private value/);
  assert.doesNotMatch(JSON.stringify({ events, projection: log.projection() }), /private (value|progress)/);
  assert.match(JSON.stringify(log.projection().contextMessages.at(-1)), /transformation failed/);
});

test('an invalid transformed request fails before the provider is invoked', async (t) => {
  const { app, paths, mock, request } = await fixture(t);
  plugin(paths.plugins, 'invalid-request', {}, `export default (_ctx, api) => {
    api.modelRequest((request) => ({ ...request, messages: [{ role: 'toolResult', toolCallId: 'missing',
      toolName: 'example', timestamp: Date.now(), isError: false, content: [] }] }));
  };`);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'invalid-request': true } })).status, 200);
  const session = app.runtime.registry.create();
  await assert.rejects(app.runtime.runs.send(session.id, 'Use this request'), /failed to transform/);
  assert.equal(mock.requests.length, 0);
  assert.equal(app.runtime.registry.log(session.id).entries().some((entry) => entry.type === 'model-request'), false);
});

test('unmount signals an active request hook and runs cleanup after it settles', { timeout: 5000 }, async (t) => {
  const { app, paths, request } = await fixture(t);
  const key = Symbol.for('mini-harness-test-hook-drain');
  let entered: () => void = () => { throw new Error('Not started'); };
  let cancelled: () => void = () => { throw new Error('Not started'); };
  let release: () => void = () => { throw new Error('Not started'); };
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const signalled = new Promise<void>((resolve) => { cancelled = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const state = { entered, cancelled, hold, cleaned: false };
  const shared = globalThis as typeof globalThis & Record<symbol, typeof state>;
  shared[key] = state;
  t.after(() => { release(); delete shared[key]; });
  plugin(paths.plugins, 'slow-transform', {}, `export default (_ctx, api) => {
    const state = globalThis[Symbol.for('mini-harness-test-hook-drain')];
    api.modelRequest(async (_request, { signal }) => {
      signal.addEventListener('abort', state.cancelled, { once: true });
      state.entered();
      await state.hold;
    });
    api.onDispose(() => { state.cleaned = true; });
  };`);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'slow-transform': true } })).status, 200);
  const session = app.runtime.registry.create();
  const run = assert.rejects(app.runtime.runs.send(session.id, 'Wait for unload'), /failed to transform/);
  await started;
  const unload = request('/settings', 'PATCH', { plugins: { 'slow-transform': false } });
  await signalled;
  try { assert.equal(state.cleaned, false); }
  finally { release(); }
  await run;
  assert.equal((await unload).status, 200);
  assert.equal(state.cleaned, true);
});
