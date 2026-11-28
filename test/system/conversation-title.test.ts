import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { LlmRequest } from '@mini-harness/llm/api';
import { waitFor } from '@mini-harness/platform/wait';
import { fixture, waitUntil } from '../support/api-fixture.ts';
import { sendRun } from '../support/runs.ts';
import { expectPresent } from '../support/required.ts';

test(
  'conversation titles use the first accepted input and respect plugin and session lifetime',
  { timeout: 30000 },
  async (t) => {
    const { app } = await fixture(t);
    const ctx = app.runtime.plugins.ctx;
    const { harnessModels: models, harnessRuns: runs, harnessSessions: sessions } = ctx;
    const model = { provider: 'title-fixture', id: 'fixture' };
    const capabilities = {
      id: model.id,
      name: 'Fixture',
      input: ['text' as const],
      contextWindow: 32000,
      maxTokens: 1024,
      reasoning: true,
      thinkingLevels: ['low', 'medium'] as const,
    };
    const requests: LlmRequest[] = [];
    const replies = new Map<string, Promise<string>>();
    const holdTitle = (input: string) => {
      let release!: (answer: string) => void;
      replies.set(
        input,
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      );
      return release;
    };
    const warnings: string[] = [];
    ctx.logger.exporter({
      export: (message) => {
        if (message.type === 'warn') warnings.push(String(message.args[0]));
      },
    });
    models.register(
      {
        list: () => [
          {
            ...model,
            input: capabilities.input,
            name: capabilities.name,
            configured: true,
            thinkingLevels: [...capabilities.thinkingLevels],
          },
        ],
        resolve: (choice) =>
          choice.provider === model.provider && choice.id === model.id
            ? { model, capabilities: { ...capabilities, thinkingLevels: [...capabilities.thinkingLevels] } }
            : undefined,
      },
      {
        accepts: (choice) => choice.provider === model.provider,
        async *stream(request) {
          const part = request.messages.at(-1)?.content[0];
          const input = part?.type === 'text' ? part.text : '';
          let text = 'Main reply';
          if (request.maxTokens === 64) {
            requests.push(request);
            text = await waitFor(replies.get(input) ?? Promise.resolve('Unexpected title'), request.signal);
          } else if (input === 'Stop current run') {
            await waitFor(new Promise<void>(() => {}), request.signal);
          }
          yield {
            type: 'done',
            message: {
              role: 'assistant',
              timestamp: Date.now(),
              stopReason: text ? 'stop' : 'error',
              content: [{ type: 'text', text }],
              ...(text ? {} : { errorMessage: 'Title provider failed' }),
            },
          };
        },
      },
    );
    const toggle = (disabled: boolean) =>
      app.runtime.configuration.update({ entries: { 'conversation-title': { disabled } } });
    const titleOf = (id: string) => sessions.get(id)?.title;
    const observedTitles = new Map<string, string | undefined>();
    ctx.on('harness/observe', (event) => {
      if (event.type === 'input-accepted' && event.source === 'user')
        observedTitles.set(event.sessionId, titleOf(event.sessionId));
    });

    const historical = sessions.create();
    const original = 'First user input '.repeat(5).trim();
    assert.equal(await sendRun(runs, historical.id, original, undefined, { model }), 'Main reply');
    assert.equal(titleOf(historical.id), original.slice(0, 72));
    assert.equal(observedTitles.get(historical.id), original.slice(0, 72));
    assert.equal(requests.length, 0);

    await toggle(false);
    await sendRun(runs, historical.id, 'After enabling', undefined, { model });
    assert.equal(titleOf(historical.id), original.slice(0, 72));
    assert.equal(requests.length, 0);

    const session = sessions.create();
    await sendRun(runs, session.id, 'Notification', undefined, { model, source: 'plugin' });
    assert.equal(titleOf(session.id), 'New conversation');
    const title = holdTitle('report.txt');
    const attachment = {
      name: 'report.txt',
      mimeType: 'text/plain',
      data: Buffer.from('Uploaded contents').toString('base64'),
    };
    assert.equal(
      await sendRun(runs, session.id, '', undefined, { model, attachments: [attachment] }),
      'Main reply',
    );
    assert.equal(titleOf(session.id), 'report.txt');
    assert.equal(observedTitles.get(session.id), 'report.txt');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].model, model);
    assert.equal(requests[0].tools, undefined);
    assert.equal(requests[0].thinkingLevel, 'low');
    assert.deepEqual(
      requests[0].messages.map(({ content }) => content),
      [[{ type: 'text', text: 'report.txt' }]],
    );
    title('Report summary');
    await waitUntil(
      () => titleOf(session.id),
      (value) => value === 'Report summary',
    );

    await sendRun(runs, session.id, 'Follow-up', undefined, { model });
    const log = sessions.log(session.id);
    const sourceEntryId = expectPresent(log.firstUserInputId(), 'first input');
    await runs.reviseAndStart(session.id, {
      sourceEntryId,
      expectedLeafId: log.context().leafId,
      message: 'Revised',
      model,
    });
    await runs.current(session.id)?.result;
    assert.equal(log.firstUserInputId(), sourceEntryId);
    assert.equal(titleOf(session.id), 'Report summary');
    assert.equal(requests.length, 1);

    const manual = sessions.create();
    const late = holdTitle('Name manually');
    await sendRun(runs, manual.id, 'Name manually', undefined, { model });
    sessions.rename(manual.id, 'New conversation');
    late('Late model title');
    await setImmediate();
    assert.equal(titleOf(manual.id), 'New conversation');
    await sendRun(runs, manual.id, 'Later input', undefined, { model });
    const alreadyNamed = sessions.create({ title: 'Manual from creation' });
    await sendRun(runs, alreadyNamed.id, 'Leave the title', undefined, { model });
    assert.equal(titleOf(alreadyNamed.id), 'Manual from creation');
    assert.equal(requests.length, 2);

    replies.set('Title fails', Promise.resolve(''));
    const failed = sessions.create();
    assert.equal(await sendRun(runs, failed.id, 'Title fails', undefined, { model }), 'Main reply');
    await waitUntil(
      () => warnings,
      (items) => items.some((item) => item.includes('Title provider failed')),
    );
    assert.equal(titleOf(failed.id), 'Title fails');

    const removed = sessions.create();
    const removedTitle = holdTitle('Delete session');
    await sendRun(runs, removed.id, 'Delete session', undefined, { model });
    await sessions.delete([removed.id]);
    removedTitle('Deleted title');
    await waitUntil(
      () => warnings,
      (items) => items.some((item) => item.includes('Conversation not found')),
    );
    assert.equal(sessions.get(removed.id), undefined);

    const stopped = sessions.create();
    const stoppedTitle = holdTitle('Stop current run');
    const stop = assert.rejects(
      sendRun(runs, stopped.id, 'Stop current run', undefined, { model }),
      /Stopped by the user/,
    );
    await waitUntil(
      () => requests.length,
      (count) => count === 5,
    );
    assert.ok(runs.stop(stopped.id));
    await stop;
    stoppedTitle('Stopped run title');
    await waitUntil(
      () => titleOf(stopped.id),
      (value) => value === 'Stopped run title',
    );

    const disabled = sessions.create();
    holdTitle('Disable title plugin');
    await sendRun(runs, disabled.id, 'Disable title plugin', undefined, { model });
    assert.equal(requests.length, 6);
    await toggle(true);
    assert.ok(requests[5].signal.aborted);
    assert.equal(titleOf(disabled.id), 'Disable title plugin');
    await sendRun(runs, disabled.id, 'Continue after disabling', undefined, { model });
    assert.equal(requests.length, 6);
  },
);
