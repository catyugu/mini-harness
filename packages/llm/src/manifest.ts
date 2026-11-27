import { Service, type Context, type Plugin } from 'mini-harness/cordis';
import { rankScoped, sameRank, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { LlmAdapter, LlmPort } from './api.ts';

export const metadata = {
  title: 'Model transport',
  description: 'Select a registered adapter to stream a model response',
};

const plugin: Plugin.Object = {
  provide: ['harnessLlm'],
  apply(ctx) {
    const adapters = new Set<{
      adapter: LlmAdapter;
      priority: number;
      owner: Context;
      signal: AbortSignal;
      scope?: ScopeKey;
    }>();
    const changed = () => {
      void ctx.parallel('llm/adapters-changed').catch((error) => ctx.logger.warn(String(error)));
    };
    function selected(caller: Context, model: import('./vocabulary.ts').ModelChoice) {
      const [entry, next] = rankScoped(scopeOf(caller), adapters).filter(
        ({ adapter, signal }) => !signal.aborted && adapter.accepts(model),
      );
      return entry && sameRank(entry, next) ? null : entry;
    }
    const llm = Service.track<LlmPort>({
      register(adapter, priority = 0) {
        const caller = Service.caller(this);
        const entry = {
          adapter,
          priority,
          owner: caller,
          signal: caller.fiber.signal,
          scope: scopeOf(caller),
        };
        adapters.add(entry);
        changed();
        return () => {
          if (adapters.delete(entry)) changed();
        };
      },
      select(model) {
        const entry = selected(Service.caller(this), model);
        return entry === null ? null : entry?.adapter;
      },
      async countInputTokens(request) {
        const entry = selected(Service.caller(this), request.model);
        if (!entry) return;
        const count = entry.adapter.countInputTokens;
        if (count)
          return entry.owner.fiber.run(
            (signal) => count.call(entry.adapter, { ...request, signal }),
            AbortSignal.any([entry.signal, request.signal]),
          );
      },
      async stream(request, emit) {
        request.signal.throwIfAborted();
        const entry = selected(Service.caller(this), request.model);
        const model = request.model.provider + '/' + request.model.id;
        if (entry === null) throw new Error('Multiple model adapters accept ' + model);
        if (!entry) throw new Error('No model adapter accepts ' + model);
        await entry.owner.fiber.run(
          async (signal) => {
            const iterator = entry.adapter.stream({ ...request, signal })[Symbol.asyncIterator]();
            let exhausted = false;
            try {
              while (true) {
                const next = await iterator.next();
                if (next.done) {
                  exhausted = true;
                  return;
                }
                signal.throwIfAborted();
                emit(next.value);
              }
            } finally {
              if (!exhausted) await iterator.return?.();
            }
          },
          AbortSignal.any([entry.signal, request.signal]),
        );
      },
    });
    ctx.provide('harnessLlm', llm);
  },
};

export default plugin;
