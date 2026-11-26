import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mini-harness/tools/api';
import { validateRequestSnapshot } from '@mini-harness/llm/api';
import { checkpointFixture } from '../../../test/helpers/mock-provider.ts';
import { fixture } from '../../../test/support/api-fixture.ts';
import { sendRun } from '../../../test/support/runs.ts';
import { SessionLog } from '../../sessions/src/log.ts';
import type { SessionLogPort } from '@mini-harness/sessions/log-api';
import type { MockProvider } from '../../../test/helpers/mock-provider.ts';

const settings = {
  autoCompact: true,
  triggerRatio: 0.8,
  targetRatio: 0.6,
  retainRatio: 0.16,
  summaryModel: null,
};
const summary = (content?: string) => content?.startsWith('Write a continuation checkpoint');
const withUsage = (text: string) => ({
  text,
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 80 },
  },
});

function assertPaired(log: SessionLogPort, mock: MockProvider) {
  const requests = log.entries().filter(({ type }) => type === 'model-request');
  assert.ok(requests.length > 2);
  assert.equal(requests.length, mock.requests.length);
  for (const request of requests) validateRequestSnapshot(log.requestSnapshot(request.id));
}

test('a single user turn supports repeated token-budget compaction while tools execute once', async (t) => {
  let calls = 0;
  let checkpoints = 0;
  const { app, mock, request } = await fixture(t, ({ messages }) => {
    if (summary(messages.at(-1)?.content)) {
      checkpoints++;
      return withUsage(checkpointFixture);
    }
    if (calls < 7)
      return {
        tool: 'probe',
        args: {},
        callId: 'probe-' + calls,
        text: 'Important diagnostics. '.repeat(1250),
      };
    return withUsage('Long task completed');
  });
  const ctx = app.runtime.plugins.ctx;
  t.after(
    ctx.harnessTools.register(
      defineTool({
        name: 'probe',
        description: 'Run the next test step',
        parameters: Type.Object({}),
        async execute() {
          calls++;
          return { content: [{ type: 'text', text: 'Probe result ' + calls }], elapsedMs: 12 };
        },
      }),
    ),
  );
  const { body: session } = await request('/sessions', 'POST', {});
  const path = '/sessions/' + session.id;
  const reply = await request(path + '/context', 'PUT', {
    ...settings,
    retainRatio: 0.1,
    targetRatio: 0.38,
    triggerRatio: 0.45,
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  await sendRun(ctx.harnessRuns, session.id, 'Complete the task and preserve the constraints');
  assert.equal(calls, 7);
  assert.ok(checkpoints >= 2);
  const log = ctx.harnessSessions.log(session.id);
  assert.equal(
    log.projection().timeline.filter((entry) => entry.type === 'message' && entry.role === 'user').length,
    1,
  );
  assert.ok(log.entries().filter(({ type }) => type === 'context-replace').length >= 2);
  const submitted = log
    .projection()
    .timeline.find((entry) => entry.type === 'message' && entry.role === 'user');
  assert.ok(submitted && log.context().contextEntryIds.includes(submitted.id));
  assertPaired(log, mock);

  const { body: state } = await request(path + '/context');
  assert.equal(state.turns, 1);
  assert.equal(state.steps, 8);
  assert.equal(state.toolMs, 84);
  assert.deepEqual(state.usage, {
    input: 20 * (checkpoints + 1),
    cacheRead: 80 * (checkpoints + 1),
    output: 20 * (checkpoints + 1),
  });
  assert.ok(state.occupancy.total < state.occupancy.window);
  assert.deepEqual(Object.values(state.assistantUsage), [state.usage]);
});

test('context overflow repairs the current request and leaves raw, duplicate tool results recoverable', async (t) => {
  let calls = 0,
    overflowed = false;
  let restored = false;
  let entryId = '';
  const payload = 'diagnostics '.repeat(1200);
  const { app, request } = await fixture(t, ({ messages }) => {
    const last = messages.at(-1);
    if (summary(last?.content)) return checkpointFixture;
    if (last?.content === 'Trigger a probe') return { tool: 'probe', args: {}, callId: 'first-probe' };
    if (last?.content === 'Repeat the probe') return { tool: 'probe', args: {}, callId: 'second-probe' };
    if (calls === 2 && !overflowed) {
      overflowed = true;
      assert.match(last?.content ?? '', /Identical tool output/);
      return { overflow: 'context' };
    }
    if (last?.content === 'Read back the full diagnostic') {
      return { tool: 'read_context', args: { entry: entryId }, callId: 'read-original' };
    }
    if (last?.role === 'tool' && last.content.startsWith('diagnostics')) restored = true;
    return 'Done';
  });
  const ctx = app.runtime.plugins.ctx;
  t.after(
    ctx.harnessTools.register(
      defineTool({
        name: 'probe',
        description: 'Return a stable diagnostic',
        tags: ['readOnly'],
        parameters: Type.Object({}),
        async execute() {
          calls++;
          return { content: [{ type: 'text', text: payload }] };
        },
      }),
    ),
  );
  const { body: session } = await request('/sessions', 'POST', {});
  await sendRun(ctx.harnessRuns, session.id, 'Trigger a probe');
  await sendRun(ctx.harnessRuns, session.id, 'Repeat the probe');
  assert.equal(calls, 2);
  assert.equal(overflowed, true);
  const log = ctx.harnessSessions.log(session.id);
  const latest = log
    .projection()
    .timeline.find(
      (entry) =>
        entry.type === 'message' && entry.role === 'toolResult' && entry.toolCallId === 'second-probe',
    );
  assert.ok(latest);
  entryId = latest.id;
  assert.deepEqual(log.originalMessage(entryId)?.content, [{ type: 'text', text: payload }]);
  for (const entry of log.entries().filter(({ type }) => type === 'model-request'))
    validateRequestSnapshot(log.requestSnapshot(entry.id));
  await sendRun(ctx.harnessRuns, session.id, 'Read back the full diagnostic');
  assert.equal(restored, true);
});

test('session overrides inherit defaults, reject invalid ratios and accept unstructured checkpoints', async (t) => {
  const { app, request, paths } = await fixture(t, ({ messages }) =>
    summary(messages.at(-1)?.content) ? 'Continue the earlier task.' : 'Answer to the task',
  );
  const ctx = app.runtime.plugins.ctx;
  const { body: session } = await request('/sessions', 'POST', {});
  const path = '/sessions/' + session.id;
  assert.equal((await request(path + '/context', 'PUT', { ...settings, targetRatio: 0.85 })).status, 400);
  assert.equal((await request(path + '/context', 'PUT', { autoCompact: false })).status, 400);
  assert.equal((await request(path + '/context', 'PUT', { ...settings, autoCompact: false })).status, 200);
  await app.runtime.configuration.update({
    entries: { 'context-management': { config: { triggerRatio: 0.9 } } },
  });
  const { body: configured } = await request(path + '/context');
  assert.deepEqual(configured.custom, { ...settings, autoCompact: false });
  assert.equal(configured.settings.triggerRatio, 0.8);
  await sendRun(ctx.harnessRuns, session.id, 'First request. '.repeat(60));
  await sendRun(ctx.harnessRuns, session.id, 'Second request. '.repeat(60));
  const sessionLog = ctx.harnessSessions.log(session.id);
  const before = sessionLog.projection();
  const compacted = await request(path + '/compact', 'POST');
  assert.equal(compacted.status, 200, JSON.stringify(sessionLog.entries().filter((entry) => entry.type === 'task').at(-1)));
  assert.ok(sessionLog.context().contextMessages.length < before.contextMessages.length);
  const exported = ctx.harnessSessions.export([session.id])[0];
  const copy = join(paths.cwd, 'reopened-log.jsonl');
  writeFileSync(copy, exported.log);
  const restored = new SessionLog(copy, session.id);
  try {
    assert.deepEqual(restored.context(), sessionLog.context());
    assert.deepEqual(restored.setting('context-management'), { ...settings, autoCompact: false });
  } finally {
    restored.close();
  }
  assert.ok(readFileSync(copy, 'utf8').includes('model-attempt'));
  assert.equal((await request(path + '/context', 'PUT', null)).status, 200);
  const inherited = (await request(path + '/context')).body;
  assert.equal(inherited.custom, null);
  assert.equal(inherited.settings.triggerRatio, 0.9);
  assert.equal(sessionLog.setting('context-management'), undefined);
});

test('switching to a smaller window uses the configured summary model and segments its input', async (t) => {
  const { app, request, mock } = await fixture(
    t,
    ({ messages }) => (summary(messages.at(-1)?.content) ? checkpointFixture : 'Done'),
    (paths) => {
      const file = join(paths.home, 'models.json');
      const models = JSON.parse(readFileSync(file, 'utf8'));
      const catalog = models.providers['local-mock'].models;
      catalog.push(
        { ...catalog[0], id: 'smaller', name: 'Smaller model', contextWindow: 9000 },
        { ...catalog[0], id: 'summary', name: 'Summary model', contextWindow: 5500, maxTokens: 512 },
      );
      writeFileSync(file, JSON.stringify(models));
    },
  );
  const ctx = app.runtime.plugins.ctx;
  const { body: session } = await request('/sessions', 'POST', {});
  const endpoint = '/sessions/' + session.id + '/context';
  const summaryModel = { provider: 'local-mock', id: 'summary' };
  assert.equal((await request(endpoint, 'PUT', { ...settings, summaryModel })).status, 200);
  for (let index = 0; index < 3; index++)
    await sendRun(ctx.harnessRuns, session.id, 'Document ' + index + '\n' + 'Prior context. '.repeat(1000));
  const model = { provider: 'local-mock', id: 'smaller' };
  await sendRun(ctx.harnessRuns, session.id, 'Continue under the original constraints', undefined, { model });
  assert.equal(mock.requests.at(-1)?.model, model.id);
  assert.ok(mock.requests.filter((request) => request.model === summaryModel.id).length >= 2);
  const { body: state } = await request(endpoint);
  assert.equal(state.occupancy.window, 9000);
  assert.equal(state.occupancy.model.id, model.id);
  assert.ok(state.occupancy.total < state.occupancy.budget);
});

test('an image limit offloads the oldest image and an irreducible overflow exits with a reason', async (t) => {
  let imageRequests = 0;
  const { app, request } = await fixture(
    t,
    ({ messages }) => {
      const text = messages.at(-1)?.content;
      if (text === 'Second image' && ++imageRequests === 1) return { overflow: 'image' };
      if (text === 'Always overflow') return { overflow: 'context' };
      return 'Done';
    },
    (paths) => {
      const file = join(paths.home, 'models.json');
      const models = JSON.parse(readFileSync(file, 'utf8'));
      models.providers['local-mock'].models[0].input.push('image');
      writeFileSync(file, JSON.stringify(models));
    },
  );
  const ctx = app.runtime.plugins.ctx;
  const { body: session } = await request('/sessions', 'POST', {});
  const attachment = { name: 'sample.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  await sendRun(ctx.harnessRuns, session.id, 'First image', undefined, { attachments: [attachment] });
  await sendRun(ctx.harnessRuns, session.id, 'Second image', undefined, { attachments: [attachment] });
  assert.equal(imageRequests, 2);
  const log = ctx.harnessSessions.log(session.id);
  const images = (content: ReturnType<typeof log.context>['contextMessages']) =>
    content.flatMap((message) =>
      typeof message.content === 'string' ? [] : message.content.filter((part) => part.type === 'image'),
    );
  assert.equal(images(log.context().contextMessages).length, 1);
  const requests = log.entries().filter(({ type }) => type === 'model-request');
  assert.equal(images(log.requestSnapshot(requests[1].id).messages).length, 2);
  const { body: plain } = await request('/sessions', 'POST', {});
  assert.equal(
    (await request('/sessions/' + plain.id + '/context', 'PUT', { ...settings, autoCompact: false })).status,
    200,
  );
  await assert.rejects(sendRun(ctx.harnessRuns, plain.id, 'Always overflow'), /Automatic compaction is off/);
  const failed = ctx.harnessSessions.log(plain.id);
  assert.equal(failed.context().contextMessages.filter(({ role }) => role === 'user').length, 1);
  assert.equal(failed.entries().filter(({ type }) => type === 'model-attempt').length, 1);
});

test('cancelling a manual checkpoint keeps the active branch and releases the conversation lane', async (t) => {
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, request } = await fixture(t, async ({ messages }) => {
    if (summary(messages.at(-1)?.content)) {
      started();
      await hold;
      return checkpointFixture;
    }
    return 'Finished';
  });
  const ctx = app.runtime.plugins.ctx;
  const { body: session } = await request('/sessions', 'POST', {});
  await sendRun(ctx.harnessRuns, session.id, 'First analysis. '.repeat(150));
  await sendRun(ctx.harnessRuns, session.id, 'Next request');
  const log = ctx.harnessSessions.log(session.id);
  const before = log.context();
  const endpoint = '/sessions/' + session.id;
  const compact = request(endpoint + '/compact', 'POST');
  try {
    await Promise.race([
      entered,
      compact.then((result) => {
        throw new Error('Compaction settled before cancellation: ' + JSON.stringify(result) + ' ' + JSON.stringify(log.entries().filter((entry) => entry.type === 'task').at(-1)));
      }),
    ]);
    assert.equal((await request(endpoint + '/context')).body.compacting, 'manual');
    assert.equal((await request(endpoint + '/cancel', 'POST')).body.cancelled, true);
    assert.deepEqual((await compact).body, { cancelled: true });
    assert.deepEqual(log.context(), before);
    assert.equal((await request(endpoint + '/context')).body.compacting, undefined);
    assert.equal(await sendRun(ctx.harnessRuns, session.id, 'Continue'), 'Finished');
  } finally {
    release();
  }
});
