import { createHash } from 'node:crypto';
import { TaskPool, terminal, type TaskSnapshot } from '@mini-harness/tasks/api';
import type { Context } from 'mini-harness/cordis';
import { defineTool } from '@mini-harness/tools/api';
import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import { Delegation, type SubagentPolicy } from './delegation.ts';

/** Optional plugin: delegation, scheduling and child-model rules exist only while mounted. */
export function setup(ctx: Context) {
  const policy = () => ctx.fiber.effectiveConfig as unknown as SubagentPolicy;
  const validate = ({ model }: SubagentPolicy) => {
    if (model && !ctx.harnessModels.resolve(model))
      throw new DomainError('invalid_input', 'Unknown child model: ' + model.provider + '/' + model.id);
  };
  validate(policy());
  const pool = new TaskPool(policy().maxParallel);
  const delegation = new Delegation(ctx.harnessSessions, ctx.harnessRuns, policy, () => ctx.harnessModels.list());
  ctx.on('runs/policy', (id) =>
    ctx.harnessSessions.get(id)?.parentId
      ? { pool, provider: ctx, metadata: { reportToParent: true } }
      : undefined,
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
        'Start a child agent asynchronously. Returns its session ID and task ID immediately; the child continues independently. Use task_control to inspect, await or cancel it. Set provider/model to override the default; specifying only a provider selects its first model.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 12000 }),
        provider: Type.Optional(Type.String({ maxLength: 160 })),
        model: Type.Optional(Type.String({ maxLength: 160 })),
      }),
      isConcurrencySafe: () => true,
      execute: async (args, { signal, executionId }) => {
        const child = delegation.delegate(id, args, signal, executionId);
        return {
          state: 'finished',
          content: [{ type: 'text', text: JSON.stringify(child) }],
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
              origin: { source: 'agent', senderSessionId: id, taskId: executionId },
            });
            const receipt = { messageId, taskId };
            return {
              state: 'finished',
              content: [{ type: 'text', text: JSON.stringify(receipt) }],
              details: receipt,
            };
          },
        }),
    }),
  );
  const tasks = ctx.harnessTasks;
  const sessions = ctx.harnessSessions;
  const notify = (task: TaskSnapshot) => {
    if (!task.metadata?.reportToParent || tasks.sealed || ctx.fiber.signal.aborted) return;
    const id = task.owner.slice('session:'.length);
    const child = sessions.get(id);
    if (!child?.parentId) return;
    try {
      sessions.assertAvailable(id);
      const result = typeof task.result === 'string' ? task.result : task.error;
      const summary = 'Child run ' + task.state + (result ? ': ' + result.slice(0, 4000) : '.');
      ctx.harnessRuns.send(child.parentId, {
        message: summary,
        messageId: task.id + ':settled',
        mode: 'queue',
        origin: { source: 'agent', senderSessionId: id, taskId: task.id },
      });
    } catch (error) {
      if (!(error instanceof DomainError && ['conflict', 'not_found'].includes(error.code)))
        ctx.logger.error('Could not deliver child run notification ' + task.id, error);
    }
  };
  ctx.effect(() =>
    tasks.subscribe(({ type, task }) => {
      if (type === 'transition' && task.type === 'agent-run' && terminal(task.state))
        queueMicrotask(() => notify(task));
    }),
  );
  ctx.on('harness/start', () => {
    for (const { id, parentId } of sessions.list()) {
      if (!parentId) continue;
      for (const task of sessions.tasks(id, 'agent-run'))
        if (
          terminal(task.state) &&
          task.metadata?.reportToParent &&
          !sessions.hasInbox(parentId, task.id + ':settled')
        ) {
          const record = sessions.taskStatus(id, task.id);
          if (!record) throw new Error('Missing indexed task: ' + task.id);
          notify(record);
        }
    }
  });
}
