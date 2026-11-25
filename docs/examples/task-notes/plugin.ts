export const provide = ['taskNotes'];
export const inject = [
  'harnessSessions',
  'harnessExecution',
  'harnessApprovalRequests',
  'harnessPluginSettings',
  'harnessPluginData',
  'harnessPluginSecrets',
  'harnessPrompt',
  'harnessTools',
  'harnessPluginRoutes',
  'harnessModels',
];
import { sessionService } from 'mini-harness/plugin-scope';
import { HttpError } from 'mini-harness/transport';
import type { Context } from 'mini-harness/cordis';
import type {} from 'mini-harness/sessions';
import type {} from 'mini-harness/execution';
import type {} from 'mini-harness/approvals';
import type {} from 'mini-harness/plugin-data';
import type {} from 'mini-harness/agent/prompt';
import type {} from 'mini-harness/tools';
import type {} from 'mini-harness/models';
declare module 'mini-harness/cordis' {
  interface Context {
    taskNotes: { label(): string };
  }
}
export function validateConfig(config: Readonly<Record<string, unknown>>) {
  if (typeof config.label !== 'string' || !config.label.trim()) throw new Error('Enter a note label');
}
export function apply(ctx: Context) {
  const sessions = ctx.harnessSessions.access();
  const execute = ctx.harnessExecution;
  const confirm = ctx.harnessApprovalRequests.request.bind(ctx.harnessApprovalRequests);
  const label = () => ctx.harnessPluginSettings.get<string>('label');
  ctx.provide('taskNotes', { label });
  ctx.harnessPluginData.write('seen', true);
  const hasCredential = () => ctx.harnessPluginSecrets.read('service-token') !== undefined;
  ctx.effect(() =>
    ctx.harnessPrompt.register({ id: 'task-notes', render: () => 'Task notes are available.' }),
  );
  ctx.effect(() =>
    ctx.harnessTools.register({
      name: 'save_task_note',
      bind(sessionId) {
        return {
          name: 'save_task_note',
          description: 'Record one line of task progress.',
          parameters: {
            type: 'object',
            properties: { note: { type: 'string', maxLength: 512 } },
            required: ['note'],
          },
          async execute(_call, input) {
            const note = String(input.note);
            await ctx.harnessSessions.records(sessionId).append({ note }, { title: label(), content: note });
            return { content: [{ type: 'text', text: 'Task note saved.' }] };
          },
        };
      },
    }),
  );
  const running = new Map<string, import('mini-harness/execution').ExecutionHandle>();
  ctx.harnessPluginRoutes.register('POST', '/cancel-follow-up', async ({ body }) => {
    const { runId } = await body();
    return { cancelled: typeof runId === 'string' && (running.get(runId)?.cancel() ?? false) };
  });
  ctx.harnessPluginRoutes.register('GET', '/smoke', () => ({
    label: label(),
    ready: ctx.harnessPluginData.read('seen', false),
    credential: hasCredential(),
  }));
  ctx.harnessPluginRoutes.register('PUT', '/credential', async ({ body }) => {
    const token = (await body())?.token;
    if (typeof token !== 'string' || !token.trim())
      throw new HttpError('invalid_input', 'Enter a service token');
    ctx.harnessPluginSecrets.write('service-token', token);
    return { credential: hasCredential() };
  });
  ctx.harnessPluginRoutes.register('POST', '/follow-up', async ({ body, signal }) => {
    const { parentId, message, requireApproval } = (await body()) ?? {};
    if (
      typeof parentId !== 'string' ||
      typeof message !== 'string' ||
      !message.trim() ||
      !sessions.get(parentId)
    )
      throw new HttpError('invalid_input', 'Provide a parent conversation and a follow-up message');
    const models = await sessionService(ctx, parentId, 'harnessModels', signal);
    const model = sessions.history(parentId).model;
    if (!model || !models.resolve(model))
      throw new HttpError('invalid_input', 'Send a message to the parent conversation first');
    if (requireApproval === true) await confirm(parentId, { title: 'Start a follow-up', message }, signal);
    const child = sessions.create({ parentId, title: 'Task follow-up' });
    const run = execute.submit(child.id, { message, model }, { signal });
    running.set(run.id, run);
    try {
      const text = await run.result;
      return { childId: child.id, runId: run.id, state: execute.status(child.id)?.state, text };
    } finally {
      running.delete(run.id);
    }
  });
}
