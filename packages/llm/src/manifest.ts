import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Service, type Context, type Plugin } from 'mini-harness/cordis';
import { rankScoped, sameRank, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { LlmAdapter, LlmEvent, LlmPort, LlmRequest, SelectedLlmAdapter } from './api.ts';

export const metadata = {
  title: 'Model transport',
  description: 'Select a registered adapter to stream a model response',
};

async function* streamOwned(
  owner: Context,
  activation: AbortSignal,
  adapter: LlmAdapter,
  request: LlmRequest,
) {
  const output = new PassThrough({ objectMode: true, highWaterMark: 1 });
  const consumer = new AbortController();
  const lifetime = AbortSignal.any([activation, request.signal, consumer.signal]);
  const work = owner.fiber.run(
    (signal) => pipeline(adapter.stream({ ...request, signal }), output, { signal }),
    lifetime,
  );
  // Fiber admission can fail before the pipeline starts.
  void work.catch((error) => output.destroy(error instanceof Error ? error : new Error(String(error))));
  try {
    for await (const event of output) {
      lifetime.throwIfAborted();
      yield event as LlmEvent;
    }
    await work;
  } finally {
    consumer.abort();
    await work.catch(() => {});
  }
}

const plugin: Plugin.Object = {
  provide: ['harnessLlm'],
  apply(ctx) {
    const adapters = new Set<{
      selection: SelectedLlmAdapter;
      priority: number;
      owner: AbortSignal;
      scope?: ScopeKey;
    }>();
    const changed = () => {
      void ctx.parallel('llm/adapters-changed').catch((error) => ctx.logger.warn(String(error)));
    };
    function matches(caller: Context, model: import('./vocabulary.ts').ModelChoice) {
      return rankScoped(scopeOf(caller), adapters).filter(
        ({ selection, owner }) => !owner.aborted && selection.accepts(model),
      );
    }
    const llm = Service.track<LlmPort>({
      register(adapter, priority = 0) {
        const caller = Service.caller(this);
        const owner = caller.fiber.signal;
        const count = adapter.countInputTokens?.bind(adapter);
        const classify = adapter.classifyError?.bind(adapter);
        const check = () => {
          owner.throwIfAborted();
          if (!adapters.has(entry)) throw new Error('Model adapter is no longer available');
        };
        const selection: SelectedLlmAdapter = {
          matches: (candidate) => candidate === adapter,
          accepts: (model) => adapter.accepts(model),
          stream(request) {
            check();
            return streamOwned(caller, owner, adapter, request);
          },
          classifyError:
            classify && ((error) => (owner.aborted || !adapters.has(entry) ? undefined : classify(error))),
          countInputTokens:
            count &&
            ((request) => {
              check();
              return caller.fiber.run(
                (signal) => count({ ...request, signal }),
                AbortSignal.any([owner, request.signal]),
              );
            }),
        };
        const entry = { selection, priority, owner, scope: scopeOf(caller) };
        adapters.add(entry);
        changed();
        return () => {
          if (adapters.delete(entry)) changed();
        };
      },
      select(model) {
        const [entry, next] = matches(Service.caller(this), model);
        return entry && sameRank(entry, next) ? null : entry?.selection;
      },
      async *stream(request) {
        request.signal.throwIfAborted();
        const [entry, next] = matches(Service.caller(this), request.model);
        const model = request.model.provider + '/' + request.model.id;
        if (!entry) throw new Error('No model adapter accepts ' + model);
        if (sameRank(entry, next)) throw new Error('Multiple model adapters accept ' + model);
        yield* entry.selection.stream(request);
      },
    });
    ctx.provide('harnessLlm', llm);
  },
};

export default plugin;
