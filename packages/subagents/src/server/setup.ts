import { createHash } from 'node:crypto';
import { TaskPool } from '@mini-harness/tasks/api';
import type { Context } from 'mini-harness/cordis';
import { isRunning, type RunInfo } from '@mini-harness/runs/run-state';
import { defineTool } from '@mini-harness/tools/api';
import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import { Delegation, type SubagentPolicy } from './delegation.ts';

const response = (value: unknown) => ({
  state: 'finished' as const,
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

/** Optional plugin: delegation, scheduling and child-model rules exist only while mounted. */
export function setup(ctx: Context) {
  const { harnessSessions: sessions, harnessRuns: runs } = ctx;
  const policy = () => ctx.fiber.effectiveConfig as unknown as SubagentPolicy;
  const validate = ({ model }: SubagentPolicy) => {
    if (model && !ctx.harnessModels.resolve(model))
      throw new DomainError('invalid_input', 'Unknown child model: ' + model.provider + '/' + model.id);
  };
  validate(policy());
  const pool = new TaskPool(policy().maxParallel);
  const delegation = new Delegation(ctx.harnessSessions, ctx.harnessRuns, policy);
  ctx.on('runs/policy', (id) =>
    ctx.harnessSessions.get(id)?.parentId ? { pool, provider: ctx } : undefined,
  );
  ctx.on('internal/update', (next) => {
    const config = next as unknown as SubagentPolicy;
    validate(config);
    pool.limit = config.maxParallel;
  });
  const tool = (id: string) =>
    defineTool({
      name: 'delegate',
      label: 'Delegate',
      description:
        'Start a child agent asynchronously. Returns its session ID and task ID immediately; the child continues independently. Use subagent_control with its session ID to inspect, await or stop it. Set provider/model to override the default; specifying only a provider selects its first model.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 12000 }),
        provider: Type.Optional(Type.String({ maxLength: 160 })),
        model: Type.Optional(Type.String({ maxLength: 160 })),
      }),
      isConcurrencySafe: () => true,
      execute: async (args, { signal, executionId }) => {
        const child = delegation.delegate(id, args, signal, executionId);
        return {
          ...response(child),
          details: child,
          detailKeys: ['sessionId', 'state'],
        };
      },
    });
  ctx.effect(() =>
    ctx.harnessTools.register({ name: 'delegate', resolve: tool, visible: (id) => delegation.visible(id) }),
  );
  ctx.effect(() =>
    ctx.harnessTools.register({
      name: 'send_message',
      resolve: (id) =>
        defineTool({
          name: 'send_message',
          label: 'Send message',
          description:
            'Send a message to a parent or direct child conversation. Steer is the default. Sending does not end your current run.',
          parameters: Type.Object({
            sessionId: Type.String({ minLength: 1, maxLength: 128 }),
            message: Type.String({ minLength: 1, maxLength: 12000 }),
            mode: Type.Optional(
              Type.Union([Type.Literal('steer'), Type.Literal('interrupt'), Type.Literal('queue')]),
            ),
          }),
          isConcurrencySafe: () => true,
          async execute({ sessionId, message, mode = 'steer' }, { signal, callId, executionId }) {
            signal.throwIfAborted();
            const sender = ctx.harnessSessions.get(id);
            const target = ctx.harnessSessions.get(sessionId);
            if (!sender || !target || (target.id !== sender.parentId && target.parentId !== sender.id))
              throw new Error('Choose a direct parent or child conversation');
            const deliveryId = createHash('sha256')
              .update(JSON.stringify([id, executionId, callId]))
              .digest('hex');
            const { messageId, taskId } = ctx.harnessRuns.send(sessionId, {
              message,
              mode,
              messageId: 'agent:' + deliveryId,
              origin: { source: 'agent', senderSessionId: id, taskId: executionId, label: 'Agent message' },
            });
            const receipt = { messageId, taskId };
            return { ...response(receipt), details: receipt };
          },
        }),
    }),
  );
  ctx.effect(() =>
    ctx.harnessTools.register({
      name: 'subagent_control',
      resolve: (id) =>
        defineTool({
          name: 'subagent_control',
          label: 'Subagent',
          description:
            'List direct children, inspect a run and its answer (optionally by runId), or wait for or stop the active run.',
          parameters: Type.Object({
            action: Type.Union([
              Type.Literal('list'),
              Type.Literal('status'),
              Type.Literal('wait'),
              Type.Literal('stop'),
            ]),
            sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          }),
          isConcurrencySafe: ({ action }) => action !== 'wait',
          async execute({ action, sessionId, runId }, { signal, waitFor }) {
            if (action === 'list')
              return response(
                sessions
                  .list()
                  .filter(({ parentId }) => parentId === id)
                  .map(({ id, title }) => ({ sessionId: id, title, run: runs.info(id) })),
              );
            const child = sessionId && sessions.get(sessionId);
            if (!child || child.parentId !== id) throw new DomainError('not_found', 'Subagent not found');
            if (action === 'stop') runs.stop(child.id);
            const run = action === 'wait' ? await runs.wait(child.id, waitFor, signal) : runs.info(child.id);
            const details = { sessionId: child.id, title: child.title, run };
            const requested = action === 'status' ? runId : undefined;
            if (requested && requested !== run?.id) {
              const result = runs.result(child.id, requested);
              if (!result) throw new DomainError('not_found', 'Subagent run not found');
              return response({ ...details, ...result });
            }
            if ((action === 'wait' || action === 'status') && run && !isRunning(run))
              return response({ ...details, answer: runs.result(child.id, run.id)?.answer });
            return response(details);
          },
        }),
    }),
  );

  const notify = ({ run, answer }: { run: RunInfo; answer?: string }) => {
    const child = sessions.get(run.sessionId);
    if (!child?.parentId || sessions.hasInbox(child.parentId, run.id + ':settled')) return;
    try {
      sessions.assertAvailable(child.id);
      runs.send(child.parentId, {
        message: 'Child run ' + run.state + (answer ? ': ' + answer.slice(0, 4000) : '.'),
        messageId: run.id + ':settled',
        mode: 'queue',
        origin: { source: 'agent', senderSessionId: child.id, taskId: run.id, label: 'Subagent finished' },
      });
    } catch (error) {
      if (!(error instanceof DomainError && ['conflict', 'not_found', 'unavailable'].includes(error.code)))
        ctx.logger.error('Could not deliver child run notification ' + run.id, error);
    }
  };
  ctx.on('harness/observe', (event) => {
    if (event.type === 'run-ended') notify(event);
  });
  ctx.on('harness/start', () => {
    for (const { id, parentId } of sessions.list()) {
      if (!parentId) continue;
      for (const run of runs.settlements(id))
        if (!sessions.hasInbox(parentId, run.id + ':settled'))
          notify({ run, answer: run.error ?? runs.result(id, run.id)?.answer });
    }
  });
}
