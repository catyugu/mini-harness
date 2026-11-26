import type { Context, Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import type { LlmRequest } from '@mini-harness/llm/api';
import type {} from '@mini-harness/agent/events';
import type {} from '@mini-harness/runs/api';
import type {} from '@mini-harness/tasks/api';
import { prepareModelMessages, selectModel } from '@mini-harness/models/selection';
import type { SessionLogPort } from '@mini-harness/sessions/log-api';
import { defineTool } from '@mini-harness/tools/api';
import { HttpError } from '@mini-harness/transport/routes';
import { Type } from 'typebox';
import type { ContextSettings, ContextState } from '../shared/state.ts';
import { Config } from './config.ts';
import { ContextManagement, owner } from './management.ts';
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
  const manager = new ContextManagement(
    () => ctx.fiber.effectiveConfig as unknown as ContextSettings,
    notify,
  );
  const statistics = new WeakMap<Pick<SessionLogPort, 'entries'>, Statistics>();
  ctx.on('agent/prepare-request', (request, step) => {
    const scoped = ctx.harnessProfileScopes.context(`session:${step.sessionId}`);
    return manager.prepare(
      scoped,
      sessions.log(step.sessionId),
      request,
      step.rebuild,
      step.runId,
      step.recovery,
    );
  });
  ctx.on('agent/request-attempt', (id, requestId, metrics) => {
    if (metrics.usage) manager.observe(sessions.log(id), requestId, metrics.usage);
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
            await run.harnessRuns.runTask(params.id, 'compaction', async (scoped, signal) => {
              const log = sessions.log(params.id);
              const projection = log.context();
              if (!projection.contextMessages.length)
                throw new HttpError('invalid_input', 'Nothing to compact in this conversation');
              const { model } = selectModel(scoped.harnessModels, {
                explicit: projection.model,
                unavailable: 'Configure a model before compacting',
              });
              const latest = log
                .entries()
                .reverse()
                .find((entry) => entry.type === 'model-request' && !entry.request.purpose);
              const previous = latest && log.requestDefinition(latest.id);
              const rebuild = async (messages: LlmRequest['messages']): Promise<LlmRequest> => ({
                ...previous,
                model,
                systemPrompt: previous?.systemPrompt ?? '',
                messages: prepareModelMessages(scoped.harnessModels.capabilities(model), messages),
                signal,
              });
              await manager.compact(scoped, log, await rebuild(projection.contextMessages), rebuild);
            });
            return { ok: true };
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return { cancelled: true };
            throw error;
          }
        }),
      );
    });
    web.effect(() =>
      routes.register('GET', '/api/sessions/:id/context', async ({ params, signal }) => {
        const id = params.id;
        if (!sessions.get(id)) throw new HttpError('not_found', 'Conversation not found');
        const scoped = ctx.harnessProfileScopes.context(`session:${id}`);
        const result = sessions.inspectLog(
          id,
          (log) => {
            const projection = log.context();
            let entry = statistics.get(log);
            if (!entry) {
              entry = new Statistics(log);
              statistics.set(log, entry);
            }
            const { stats, latestRequest } = entry.read(projection.leafId);
            const exact = latestRequest?.transformed && latestRequest.parentId === projection.leafId;
            const definition = latestRequest && log.requestDefinition(latestRequest.id);
            const request: LlmRequest | undefined = projection.model && {
              ...definition,
              model: projection.model,
              systemPrompt: definition?.systemPrompt ?? '',
              messages:
                exact && latestRequest
                  ? log.requestSnapshot(latestRequest.id).messages
                  : projection.contextMessages,
              signal,
            };
            return {
              settings: manager.configuration(log.setting(owner)),
              stats,
              occupancy: request && manager.occupancy(scoped, log, request, projection.leafId),
            };
          },
          true,
        );
        const active = ctx.get('harnessRuns')?.current(id);
        const manual = active && ctx.harnessTasks.get(active.id)?.type === 'compaction';
        const status = manual ? { compacting: 'manual' as const } : manager.status(id);
        const settings = result?.settings ?? manager.configuration(undefined);
        return {
          ...settings,
          ...(result?.stats ?? { turns: 0, steps: 0, assistantUsage: {} }),
          ...status,
          occupancy: await result?.occupancy,
        } satisfies ContextState;
      }),
    );
    web.effect(() =>
      routes.register('PUT', '/api/sessions/:id/context', async ({ params, body }) => {
        const value = await body();
        const { custom } = manager.configuration(value);
        if (custom?.summaryModel && !ctx.harnessModels.resolve(custom.summaryModel))
          throw new HttpError('invalid_input', 'Unknown summary model');
        const log = sessions.log(params.id);
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
              return { isError: true, content: [{ type: 'text', text: 'Original message not found' }] };
            const parts =
              typeof message.content === 'string'
                ? [{ type: 'text' as const, text: message.content }]
                : message.content;
            if (image !== undefined) {
              const part = parts[image - 1];
              if (part?.type !== 'image')
                return { isError: true, content: [{ type: 'text', text: 'Original image not found' }] };
              return { content: [part] };
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
    'harnessProfileScopes',
  ],
  apply: setup,
};

export default plugin;
