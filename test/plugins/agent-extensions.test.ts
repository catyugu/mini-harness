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
    return (mock.requests.at(-1).messages as { role: string; content: string }[]).find(({ role }) => role === 'system').content;
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
    api.waterfall('beforeStep', (messages, { turn }) => turn === 1
      ? [...messages, { role: 'user', content: 'Temporary context', timestamp: Date.now() }] : messages);
    api.waterfall('modelRequest', (request) => ({ ...request, systemPrompt: request.systemPrompt + '[second]' }), 2);
    api.waterfall('modelRequest', (request) => ({ ...request, systemPrompt: request.systemPrompt + '[first]' }), 1);
    api.retryModel(({ error, attempt }) => error === 'transient transport failure' && attempt === 1 ? {} : undefined);
    api.decideTool(({ tool, callId, arguments: args }) => tool === 'check' && callId === 'denied' && args.mode === 'denied' ? 'deny' : undefined);
    api.registerTool({ name: 'check', description: 'Check mode', parameters: { type: 'object' },
      async execute(_id, { mode }) {
        if (mode !== 'allowed') throw new Error('denied invocation ran');
        return { content: [{ type: 'text', text: 'Value' }] };
      }
    });
    api.waterfall('toolResult', (content, { tool }) => tool === 'check'
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
  assert.deepEqual(log.contextMessages.filter((message) => message.role === 'toolResult').map(({ toolCallId, isError }) =>
    [toolCallId, isError]), [['denied', true], ['allowed', false]]);
  assert.equal(mock.requests.length, 0);
  assert.equal((await request('/settings', 'PATCH', { plugins: { transport: false, pipeline: false }, providers: {} })).status, 200);
  assert.equal(await app.runtime.runs.send(session.id, 'Restore the built-in LLM'), 'Mock response');
});
