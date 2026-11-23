import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../support/api-fixture.js';

test('scoped model catalogs govern explicit runs and inherited or model-selected delegation without changing siblings', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  const folder = join(paths.plugins, 'scoped-models');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ scope: 'session', provides: ['harnessModels', 'harnessLlm'] }));
  writeFileSync(join(folder, 'plugin.js'), `
    export default (_ctx, api) => {
      const provider = 'scoped-only';
      const ids = ['parent-model', 'child-model'];
      const resolve = (choice) => {
        const id = choice?.id || ids[0];
        if (choice?.provider !== provider || !ids.includes(id)) return undefined;
        return { provider, id };
      };
      const list = () => ids.map(id => ({ provider, id, name: id, configured: true, thinkingLevels: ['off'] }));
      api.provide('harnessModels', {
        list, available: async () => list(), resolve,
        capabilities(choice) {
          const model = resolve(choice);
          return { id: model.id, name: model.id, input: ['text'], contextWindow: 32000, maxTokens: 1024, reasoning: false };
        }
      });
      api.provide('harnessLlm', {
        async *stream(request) {
          request.signal.throwIfAborted();
          const model = resolve(request.model);
          const last = request.messages.at(-1);
          const text = typeof last.content === 'string' ? last.content : last.content.filter(part => part.type === 'text').map(part => part.text).join('');
          if (last.role === 'user' && (text === 'Delegate inherited' || text === 'Delegate explicit')) {
            if (!request.tools.some(tool => tool.name === 'delegate')) throw new Error('Delegation tool unavailable');
            const explicit = text === 'Delegate explicit';
            yield { type: 'done', message: { role: 'assistant', provider, model: model.id, timestamp: Date.now(), stopReason: 'toolUse',
              content: [{ type: 'toolCall', id: request.sessionId + (explicit ? '-explicit' : '-inherited'), name: 'delegate',
                arguments: { task: explicit ? 'Explicit child task' : 'Inherited child task', ...(explicit ? { provider, model: 'child-model' } : {}) } }] } };
          } else {
            const answer = 'Scoped ' + model.id;
            yield { type: 'text-delta', text: answer };
            yield { type: 'done', message: { role: 'assistant', provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
              content: [{ type: 'text', text: answer }] } };
          }
        }
      });
    };
  `);
  const parent = app.runtime.registry.create();
  const sibling = app.runtime.registry.create();
  const scopedChoice = { provider: 'scoped-only', id: 'parent-model' };
  const applicationChoice = { ...app.runtime.plugins.ctx.harnessModelPreference.recent() };
  assert.equal(app.runtime.plugins.ctx.harnessModels.resolve(scopedChoice), undefined);
  const configured = await request('/settings', 'PATCH', { scopes: {
    ['session:' + parent.id]: { plugins: { 'scoped-models': true },
      providers: { harnessModels: 'scoped-models', harnessLlm: 'scoped-models' } }
  } });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  assert.equal(await app.runtime.runs.send(parent.id, 'Delegate inherited', undefined, { model: scopedChoice }), 'Scoped parent-model');
  assert.deepEqual(app.runtime.plugins.ctx.harnessModelPreference.recent(), applicationChoice);
  assert.equal(await app.runtime.runs.send(parent.id, 'Delegate explicit', undefined, { model: scopedChoice }), 'Scoped parent-model');
  assert.equal(await app.runtime.runs.send(parent.id, 'Continue without an explicit model'), 'Scoped parent-model');
  const children = app.runtime.registry.list().filter(({ parentId }) => parentId === parent.id);
  assert.equal(children.length, 2);
  const inherited = children.find(({ title }) => title === 'Inherited child task');
  const explicit = children.find(({ title }) => title === 'Explicit child task');
  assert.ok(inherited); assert.ok(explicit);
  assert.deepEqual(app.runtime.agent.read(inherited.id).model, scopedChoice);
  assert.deepEqual(app.runtime.agent.read(explicit.id).model, { provider: 'scoped-only', id: 'child-model' });
  assert.equal(app.runtime.runs.info(inherited.id)?.state, 'completed');
  assert.equal(app.runtime.runs.info(explicit.id)?.state, 'completed');
  assert.ok(app.runtime.agent.messages(parent.id).filter(({ role }) => role === 'toolResult').every(({ isError }) => !isError));
  assert.deepEqual(app.runtime.plugins.ctx.harnessModelPreference.recent(), applicationChoice);
  assert.equal(await app.runtime.runs.send(sibling.id, 'Use the application model'), 'Mock response');
  assert.deepEqual(app.runtime.agent.read(sibling.id).model, applicationChoice);
  assert.equal(mock.requests.length, 1);
});
