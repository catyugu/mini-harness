import {
  HttpError, approvalExtensions, executionExtensions, promptExtensions, sessionExtensions, toolExtensions,
  type ConfigValidationContext, type Context, type PluginApi
} from 'mini-harness/plugin';

declare module 'mini-harness/plugin' {
  interface ServiceMap {
    taskNotes: { label(): string };
  }
}

export function validateConfig(config: Readonly<Record<string, unknown>>, _context: ConfigValidationContext) {
  if (typeof config.label !== 'string' || !config.label.trim()) throw new Error('Enter a note label');
}

export default function setup(ctx: Context, api: PluginApi) {
  const records = api.contribute(sessionExtensions.records);
  const sessions = api.contribute(sessionExtensions.access);
  const execute = api.contribute(executionExtensions.control);
  const confirm = api.contribute(approvalExtensions.request);
  const label = () => api.configuration.get<string>('label');
  ctx.provide('taskNotes', { label });
  api.storage.write('seen', true);
  const hasCredential = () => api.secrets.read('service-token') !== undefined;
  api.contribute(promptExtensions.section, { id: 'task-notes', render: () => 'Task notes are available.' });
  api.contribute(toolExtensions.register, {
    name: 'save_task_note',
    bind(sessionId) {
      return {
        name: 'save_task_note',
        description: 'Record one line of task progress.',
        parameters: { type: 'object', properties: { note: { type: 'string', maxLength: 512 } }, required: ['note'] },
        async execute(_call, input) {
          const note = String(input.note);
          await records.append(sessionId, { note }, { title: label(), content: note });
          return { content: [{ type: 'text', text: 'Task note saved.' }] };
        }
      };
    }
  });
  const running = new Map<string, import('mini-harness/plugin').ExecutionHandle>();
  api.registerRoute('POST', '/cancel-follow-up', async ({ body }) => {
    const { runId } = await body();
    return { cancelled: typeof runId === 'string' && (running.get(runId)?.cancel() ?? false) };
  });
  api.registerRoute('GET', '/smoke', () => ({ label: label(), ready: api.storage.read('seen', false), credential: hasCredential() }));
  api.registerRoute('PUT', '/credential', async ({ body }) => {
    const token = (await body())?.token;
    if (typeof token !== 'string' || !token.trim()) throw new HttpError('invalid_input', 'Enter a service token');
    api.secrets.write('service-token', token);
    return { credential: hasCredential() };
  });
  api.registerRoute('POST', '/follow-up', async ({ body, signal }) => {
    const { parentId, message, requireApproval } = (await body()) ?? {};
    if (typeof parentId !== 'string' || typeof message !== 'string' || !message.trim() || !sessions.get(parentId))
      throw new HttpError('invalid_input', 'Provide a parent conversation and a follow-up message');
    await api.prepareSession(parentId, signal);
    const model = sessions.history(parentId).model;
    if (!model || !api.scopedService(parentId, 'harnessModels').resolve(model)) throw new HttpError('invalid_input', 'Send a message to the parent conversation first');
    if (requireApproval === true)
      await confirm(parentId, { title: 'Start a follow-up', message }, signal);
    const child = sessions.create({ parentId, title: 'Task follow-up' });
    const run = execute.submit(child.id, { message, model }, { signal });
    running.set(run.id, run);
    try {
      const text = await run.result;
      return { childId: child.id, runId: run.id, state: execute.status(child.id)?.state, text };
    }
    finally { running.delete(run.id); }
  });
}
