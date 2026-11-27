import { Service, type Context, type Plugin } from 'mini-harness/cordis';
import { rankScoped, sameRank, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import { ModelTransportError, type LlmAdapter, type LlmPort } from './api.ts';

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
      bind(choice) {
        const caller = Service.caller(this);
        const entry = selected(caller, choice);
        const model = choice.provider + '/' + choice.id;
        if (entry === null) throw new Error('Multiple model adapters accept ' + model);
        if (!entry) throw new Error('No model adapter accepts ' + model);
        const validate = (request: import('./api.ts').LlmRequest) => {
          request.signal.throwIfAborted();
          if (request.model.provider !== choice.provider || request.model.id !== choice.id)
            throw new Error('Model request does not match its adapter binding');
          if (selected(caller, choice) !== entry)
            throw new Error('Model adapter changed after request preparation: ' + model);
        };
        return {
          async countInputTokens(request) {
            validate(request);
            const count = entry.adapter.countInputTokens;
            if (count)
              return entry.owner.fiber.run(
                (signal) => count.call(entry.adapter, { ...request, signal }),
                AbortSignal.any([entry.signal, request.signal]),
              );
          },
          async stream(request, emit) {
            validate(request);
            await entry.owner.fiber.run(
              async (signal) => {
                let iterator: AsyncIterator<import('./api.ts').LlmEvent>;
                try {
                  iterator = entry.adapter.stream({ ...request, signal })[Symbol.asyncIterator]();
                } catch (error) {
                  throw new ModelTransportError(error, entry.adapter.classifyError?.(error));
                }
                let exhausted = false;
                try {
                  while (true) {
                    let next: IteratorResult<import('./api.ts').LlmEvent>;
                    try {
                      next = await iterator.next();
                    } catch (error) {
                      signal.throwIfAborted();
                      throw new ModelTransportError(error, entry.adapter.classifyError?.(error));
                    }
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
        };
      },
    });
    ctx.provide('harnessLlm', llm);
  },
};

export default plugin;
