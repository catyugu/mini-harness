import type { Context, Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { modelRetry } from '@mini-harness/agent/events';
import type { LlmRequest } from '@mini-harness/llm/api';
import type {} from '@mini-harness/runs/api';
import { terminal } from '@mini-harness/tasks/api';
import { prepareModelMessages, selectModel } from '@mini-harness/models/selection';
import type { SessionLogPort } from '@mini-harness/sessions/log-api';
import { defineTool } from '@mini-harness/tools/api';
import { HttpError } from '@mini-harness/transport/routes';
import { Type } from 'typebox';
import type { ContextState } from '../shared/state.ts';
import { Config, validateSettings } from './config.ts';
import { configuration, ContextManagement, owner } from './management.ts';
import { Statistics } from './statistics.ts';

export const metadata: PluginInfo = {
  title: 'Context Management',
  description: 'Prepare model context, compact history and track conversation usage',
  browser: 'packages/context-management/src/browser/setup.js',
  browserStyles: ['packages/context-management/src/browser/style.css'],
};

function setup(ctx: Context) {
  const { harnessSessions: sessions, harnessChanges: changes } = ctx;
  const notify = (id?: string) => changes.invalidate('context-management', id);
  const defaults = () => validateSettings(ctx.fiber.effectiveConfig);
  const statistics = new WeakMap<Pick<SessionLogPort, 'entries'>, Statistics>();
  const createManager = (scoped: Context, id: string) =>
    new ContextManagement(scoped.harnessModels, scoped.harnessLlm, modelRetry(scoped, id));
  ctx.on('agent/prepare-request', (request, step) => {
    const log = sessions.log(step.sessionId);
    return createManager(step.context, step.sessionId).prepare(
      log,
      { ...request, signal: step.signal },
      (messages) => step.rebuild(messages, step.signal),
      configuration(log.setting(owner), defaults()).settings,
      step.runId,
      step.failure,
    );
  });
  ctx.effect(() => changes.register('context-management'));
  ctx.effect(() => ctx.harnessProfileConfig.subscribe(() => notify()));
  ctx.effect(() => {
    const change = (event: Event) => {
      if (event instanceof CustomEvent && event.detail.entryType) notify(event.detail.id);
    };
    sessions.events.addEventListener('change', change);
    return () => sessions.events.removeEventListener('change', change);
  });

  ctx.inject(['harnessRoutes'], (web) => {
    const { harnessRoutes: routes } = web;
    web.inject(['harnessRuns'], (run) => {
      run.effect(() =>
        routes.register('POST', '/api/sessions/:id/compact', async ({ params }) => {
          try {
            const compacted = await run.harnessRuns.runTask(
              ctx,
              params.id,
              'compaction',
              async (scoped, signal, taskId) => {
                const log = sessions.log(params.id);
                const projection = log.context();
                if (!projection.contextMessages.length)
                  throw new HttpError('invalid_input', 'Nothing to compact in this conversation');
                const { harnessModels: models } = scoped;
                const ancestors = new Set(log.branch().map(({ id }) => id));
                const latest = log
                  .entries()
                  .reverse()
                  .find(
                    (entry) =>
                      entry.type === 'model-request' &&
                      !entry.request.purpose &&
                      entry.parentId !== null &&
                      ancestors.has(entry.parentId),
                  );
                if (!latest)
                  throw new HttpError('invalid_input', 'No model request has been prepared for this branch');
                const {
                  model: choice,
                  systemPrompt,
                  tools,
                  thinkingLevel,
                  maxTokens,
                } = log.requestDefinition(latest.id);
                const { model } = selectModel(models, { explicit: choice });
                const rebuild = async (messages: LlmRequest['messages']): Promise<LlmRequest> => ({
                  model,
                  systemPrompt,
                  tools,
                  thinkingLevel,
                  maxTokens,
                  messages: prepareModelMessages(models.capabilities(model), messages),
                  signal,
                });
                const manager = createManager(scoped, params.id);
                const request = await manager.prune(log, await rebuild(projection.contextMessages), rebuild);
                const compacted = await manager.compact(
                  log,
                  request,
                  rebuild,
                  configuration(log.setting(owner), defaults()).settings,
                  taskId,
                );
                return Boolean(compacted);
              },
            );
            return { ok: true, compacted };
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return { cancelled: true };
            throw error;
          }
        }),
      );
    });
    web.effect(() =>
      routes.register('GET', '/api/sessions/:id/context', async ({ params }) => {
        const id = params.id;
        if (!sessions.get(id)) throw new HttpError('not_found', 'Conversation not found');
        const result = sessions.inspectLog(
          id,
          (log) => {
            const projection = log.context();
            let entry = statistics.get(log);
            if (!entry) {
              entry = new Statistics(log);
              statistics.set(log, entry);
            }
            return {
              ...configuration(log.setting(owner), defaults()),
              ...entry.read(projection.leafId),
            };
          },
          true,
        );
        const manual = ctx.harnessTasks
          .list('session:' + id)
          .some((task) => task.type === 'compaction' && !terminal(task.state));
        return {
          ...(result ?? { ...configuration(undefined, defaults()), turns: 0, steps: 0, assistantUsage: {} }),
          compacting: manual ? 'manual' : undefined,
        } satisfies ContextState;
      }),
    );
    web.effect(() =>
      routes.register('PUT', '/api/sessions/:id/context', async ({ params, body }) => {
        const value = await body();
        const custom = value === null ? null : validateSettings(value);
        if (custom?.summaryModel && !ctx.harnessModels.resolve(custom.summaryModel))
          throw new HttpError('invalid_input', 'Unknown summary model');
        const log = sessions.log(params.id);
        if (custom || log.setting(owner) != null)
          log.append({ type: 'session-setting', owner, value: custom });
        return { ok: true };
      }),
    );
  });

  ctx.effect(() =>
    ctx.harnessTools.register({
      name: 'read_context',
      visible: (id) => Boolean(sessions.get(id)),
      resolve: (id) =>
        defineTool({
          name: 'read_context',
          label: 'Read original context',
          description:
            'Read an original message, attachment or tool result by its session entry ID. Large text results are paged.',
          tags: ['readOnly'],
          parameters: Type.Object(
            {
              entry: Type.String({ pattern: '^[a-fA-F0-9]{8,64}$' }),
              offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_073_741_824 })),
              limit: Type.Optional(Type.Integer({ minimum: 128, maximum: 12_000 })),
              image: Type.Optional(Type.Integer({ minimum: 1 })),
              raw: Type.Optional(
                Type.Boolean({ description: 'Read the raw tool execution before result transforms.' }),
              ),
            },
            { additionalProperties: false },
          ),
          async execute({ entry, offset = 0, limit = 2400, image, raw }) {
            const message = sessions.log(id).originalMessage(entry, raw);
            if (!message)
              return { state: 'error', content: [{ type: 'text', text: 'Original message not found' }] };
            const parts =
              typeof message.content === 'string'
                ? [{ type: 'text' as const, text: message.content }]
                : message.content;
            if (image !== undefined) {
              const part = parts[image - 1];
              if (part?.type !== 'image')
                return { state: 'error', content: [{ type: 'text', text: 'Original image not found' }] };
              return { state: 'finished', content: [part] };
            }
            const text = parts
              .flatMap((part, index) =>
                part.type === 'text'
                  ? [part.text]
                  : part.type === 'image'
                    ? ['[Image ' + (index + 1) + ']']
                    : [],
              )
              .join('\n');
            const end = Math.min(offset + limit, text.length);
            return {
              state: 'finished',
              content: [
                {
                  type: 'text',
                  text:
                    text.slice(offset, end) +
                    (end < text.length ? '\n[Continue with offset ' + end + ']' : ''),
                },
              ],
            };
          },
        }),
    }),
  );
}

const plugin: Plugin.Object = {
  Config,
  inject: [
    'harnessSessions',
    'harnessModels',
    'harnessLlm',
    'harnessTasks',
    'harnessTools',
    'harnessChanges',
    'harnessProfileConfig',
  ],
  apply: setup,
};

export default plugin;
