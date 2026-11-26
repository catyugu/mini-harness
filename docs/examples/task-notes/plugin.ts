import type { Context } from 'mini-harness/cordis';
import { defineConfig } from 'mini-harness/configuration';
export const provide = ['taskNotes'];
export const inject = [
  'harnessSessions',
  'harnessRuns',
  'harnessTasks',
  'harnessApprovalRequests',
  'harnessPluginSettings',
  'harnessPluginData',
  'harnessPluginSecrets',
  'harnessPrompt',
  'harnessTools',
  'harnessRoutes',
  'harnessModels',
  'harnessProfileScopes',
];
import { HttpError } from 'mini-harness/transport';
import type { SessionStore, SessionRecords } from 'mini-harness/sessions';
import type { RunPort } from 'mini-harness/runs';
import type { TaskPort } from 'mini-harness/tasks';
import type { ApprovalRequests } from 'mini-harness/approvals';
import type { PluginData, PluginSecrets } from 'mini-harness/plugin-data';
import type { PromptPort } from 'mini-harness/agent/prompt';
import type { ToolDefinition } from 'mini-harness/tools';
import type { ModelCatalogPort } from 'mini-harness/models';
import type { RoutePort } from 'mini-harness/transport';
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
  const sessions: SessionStore = ctx.harnessSessions;
  const runs: RunPort = ctx.harnessRuns;
  const tasks: TaskPort = ctx.harnessTasks;
  const data: PluginData = ctx.harnessPluginData;
  const secrets: PluginSecrets = ctx.harnessPluginSecrets;
  const prompt: PromptPort = ctx.harnessPrompt;
  const routes: RoutePort = ctx.harnessRoutes;
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
      resolve(sessionId): ToolDefinition {
        return {
          name: 'save_task_note',
          description: 'Record one line of task progress.',
          parameters: {
            type: 'object',
            properties: { note: { type: 'string', maxLength: 512 } },
            required: ['note'],
          },
          async execute(input) {
            const note = String(input.note);
            const records: SessionRecords = ctx.harnessSessions.records(sessionId, {
              pluginId: 'task-notes',
              instanceId: 'task-notes',
            });
            await records.append({ note }, { title: label(), content: note });
            return { content: [{ type: 'text', text: 'Task note saved.' }] };
          },
        };
      },
    }),
  );
  ctx.effect(() =>
    routes.register('POST', '/api/extensions/task-notes/cancel-follow-up', async ({ body }) => {
      const { runId } = await body();
      return {
        cancelled:
          typeof runId === 'string' &&
          tasks.get(runId)?.metadata?.origin === 'task-notes' &&
          tasks.cancel(runId),
      };
    }),
  );
  ctx.effect(() =>
    routes.register('GET', '/api/extensions/task-notes/smoke', () => ({
      label: label(),
      ready: data.read('seen', false),
      credential: hasCredential(),
    })),
  );
  ctx.effect(() =>
    routes.register('PUT', '/api/extensions/task-notes/credential', async ({ body }) => {
      const token = (await body())?.token;
      if (typeof token !== 'string' || !token.trim())
        throw new HttpError('invalid_input', 'Enter a service token');
      secrets.write('service-token', token);
      return { credential: hasCredential() };
    }),
  );
  ctx.effect(() =>
    routes.register('POST', '/api/extensions/task-notes/follow-up', async ({ body, signal }) => {
      const { parentId, message, requireApproval } = (await body()) ?? {};
      if (
        typeof parentId !== 'string' ||
        typeof message !== 'string' ||
        !message.trim() ||
        !sessions.get(parentId)
      )
        throw new HttpError('invalid_input', 'Provide a parent conversation and a follow-up message');
      const scope = `session:${parentId}` as const;
      await ctx.harnessProfileScopes.prepare(scope, signal);
      const models: ModelCatalogPort = ctx.harnessProfileScopes.context(scope).harnessModels;
      const model = sessions.history(parentId).model;
      if (!model || !models.resolve(model))
        throw new HttpError('invalid_input', 'Send a message to the parent conversation first');
      if (requireApproval === true) await confirm(parentId, { title: 'Start a follow-up', message }, signal);
      const child = sessions.create({ parentId, title: 'Task follow-up' });
      const { taskId } = runs.send(child.id, {
        message,
        model,
        origin: { source: 'plugin', senderSessionId: parentId },
      });
      if (!taskId) throw new Error('The follow-up was accepted but could not start');
      const task = await tasks.wait(taskId, signal);
      return { childId: child.id, runId: task.id, state: task.state, text: task.result };
    }),
  );
}
