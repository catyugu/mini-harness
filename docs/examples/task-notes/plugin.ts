import { defineConfig } from 'mini-harness/configuration';
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
];
import { sessionService } from 'mini-harness/plugin-scope';
import { HttpError } from 'mini-harness/transport';
import type { Context } from 'mini-harness/cordis';
import type { SessionAccess, SessionRecords } from 'mini-harness/sessions';
import type { Execution } from 'mini-harness/execution';
import type { ApprovalRequests } from 'mini-harness/approvals';
import type { PluginData, PluginSecrets } from 'mini-harness/plugin-data';
import type { PromptPort } from 'mini-harness/agent/prompt';
import type { ToolDefinition } from 'mini-harness/tools';
import type { ModelCatalogPort } from 'mini-harness/models';
import type { PluginRoutes } from 'mini-harness/transport';
declare module 'mini-harness/cordis' {
  interface Context {
    taskNotes: { label(): string };
  }
}
export const Config = defineConfig(
  {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        title: 'Note label',
        default: 'Task progress',
      },
    },
    additionalProperties: false,
  },
  (config) => (typeof config.label !== 'string' || !config.label.trim() ? 'Enter a note label' : undefined),
);
export function apply(ctx: Context) {
  const sessions: SessionAccess = ctx.harnessSessions.access();
  const execute: Execution = ctx.harnessExecution;
  const data: PluginData = ctx.harnessPluginData;
  const secrets: PluginSecrets = ctx.harnessPluginSecrets;
  const prompt: PromptPort = ctx.harnessPrompt;
  const routes: PluginRoutes = ctx.harnessPluginRoutes;
  const approvals: ApprovalRequests = ctx.harnessApprovalRequests;
  const confirm = approvals.request.bind(approvals);
  const label = () => ctx.harnessPluginSettings.get<string>('label');
  ctx.provide('taskNotes', { label });
  data.write('seen', true);
  const hasCredential = () => secrets.read('service-token') !== undefined;
  ctx.effect(() => prompt.register({ id: 'task-notes', render: () => 'Task notes are available.' }));
  ctx.effect(() =>
    ctx.harnessTools.register({
      name: 'save_task_note',
      bind(sessionId): ToolDefinition {
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
            const records: SessionRecords = ctx.harnessSessions.records(sessionId);
            await records.append({ note }, { title: label(), content: note });
            return { content: [{ type: 'text', text: 'Task note saved.' }] };
          },
        };
      },
    }),
  );
  const running = new Map<string, import('mini-harness/execution').ExecutionHandle>();
  routes.register('POST', '/cancel-follow-up', async ({ body }) => {
    const { runId } = await body();
    return { cancelled: typeof runId === 'string' && (running.get(runId)?.cancel() ?? false) };
  });
  routes.register('GET', '/smoke', () => ({
    label: label(),
    ready: data.read('seen', false),
    credential: hasCredential(),
  }));
  routes.register('PUT', '/credential', async ({ body }) => {
    const token = (await body())?.token;
    if (typeof token !== 'string' || !token.trim())
      throw new HttpError('invalid_input', 'Enter a service token');
    secrets.write('service-token', token);
    return { credential: hasCredential() };
  });
  routes.register('POST', '/follow-up', async ({ body, signal }) => {
    const { parentId, message, requireApproval } = (await body()) ?? {};
    if (
      typeof parentId !== 'string' ||
      typeof message !== 'string' ||
      !message.trim() ||
      !sessions.get(parentId)
    )
      throw new HttpError('invalid_input', 'Provide a parent conversation and a follow-up message');
    const models: ModelCatalogPort = await sessionService(ctx, parentId, 'harnessModels', signal);
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
