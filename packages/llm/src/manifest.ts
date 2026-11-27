import { Service, type Plugin } from 'mini-harness/cordis';
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
      owner: AbortSignal;
      scope?: ScopeKey;
    }>();
    const changed = () => {
      void ctx.parallel('llm/adapters-changed').catch((error) => ctx.logger.warn(String(error)));
    };
    function matches(
      caller: import('mini-harness/cordis').Context,
      model: import('./vocabulary.ts').ModelChoice,
    ) {
      return rankScoped(scopeOf(caller), adapters).filter(
        ({ adapter, owner }) => !owner.aborted && adapter.accepts(model),
      );
    }
    const llm = Service.track<LlmPort>({
      register(adapter, priority = 0) {
        const caller = Service.caller(this);
        const entry = { adapter, priority, owner: caller.fiber.signal, scope: scopeOf(caller) };
        adapters.add(entry);
        changed();
        return () => {
          if (adapters.delete(entry)) changed();
        };
      },
      select(model) {
        const [entry, next] = matches(Service.caller(this), model);
        return entry && sameRank(entry, next) ? null : entry?.adapter;
      },
      async *stream(request) {
        request.signal.throwIfAborted();
        const [entry, next] = matches(Service.caller(this), request.model);
        const model = request.model.provider + '/' + request.model.id;
        if (!entry) throw new Error('No model adapter accepts ' + model);
        if (sameRank(entry, next)) throw new Error('Multiple model adapters accept ' + model);
        const signal = AbortSignal.any([entry.owner, request.signal]);
        for await (const event of entry.adapter.stream({ ...request, signal })) {
          signal.throwIfAborted();
          yield event;
        }
      },
    });
    ctx.provide('harnessLlm', llm);
  },
};

export default plugin;
