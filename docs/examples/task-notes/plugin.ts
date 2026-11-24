import {
  approvalExtensions, executionExtensions, promptExtensions, sessionExtensions, toolExtensions,
  type ConfigValidationContext, type PluginApi
} from 'mini-harness/plugin';

declare module 'mini-harness/plugin' {
  interface ServiceMap {
    taskNotes: { label(): string };
  }
}

export function validateConfig(config: Readonly<Record<string, unknown>>, _context: ConfigValidationContext) {
  if (typeof config.label !== 'string' || !config.label.trim()) throw new Error('Enter a note label');
}

export default function setup(_ctx: unknown, api: PluginApi) {
  const records = api.contribute(sessionExtensions.records);
  const sessions = api.contribute(sessionExtensions.access);
  const execute = api.contribute(executionExtensions.control);
  const confirm = api.contribute(approvalExtensions.request);
  const models = api.service('harnessModels');
  const label = () => api.configuration.get<string>('label');
  api.provide('taskNotes', { label });
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
  api.registerRoute('GET', '/smoke', () => ({ label: label(), ready: api.storage.read('seen', false), credential: hasCredential() }));
  api.registerRoute('POST', '/follow-up', async ({ body, signal }) => {
    const { parentId, message, requireApproval } = await body();
    if (typeof parentId !== 'string' || typeof message !== 'string' || !message.trim() || !sessions.get(parentId))
      throw new Error('Provide a parent conversation and a follow-up message');
    const model = sessions.history(parentId).model;
    if (!model || !models.resolve(model)) throw new Error('Send a message to the parent conversation first');
    if (requireApproval === true)
      await confirm(parentId, { title: 'Start a follow-up', message }, signal);
    const child = sessions.create({ parentId, title: 'Task follow-up' });
    const run = execute.submit(child.id, { message, model }, { signal });
    return { childId: child.id, runId: run.id, text: await run.result };
  });
}
