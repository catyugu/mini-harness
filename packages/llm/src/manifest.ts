import { Service, type Plugin } from 'mini-harness/cordis';
import { scopeChainOf, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
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
    const llm = Service.track<LlmPort>({
      register(adapter, priority = 0) {
        const caller = Service.caller(this);
        const entry = { adapter, priority, owner: caller.fiber.signal, scope: scopeOf(caller) };
        adapters.add(entry);
        return () => adapters.delete(entry);
      },
      async *stream(request) {
        request.signal.throwIfAborted();
        const ancestry = [...scopeChainOf(scopeOf(Service.caller(this))), undefined];
        const matches = [...adapters]
          .filter(
            ({ adapter, owner, scope }) =>
              !owner.aborted && ancestry.includes(scope) && adapter.accepts(request.model),
          )
          .sort((a, b) => ancestry.indexOf(a.scope) - ancestry.indexOf(b.scope) || b.priority - a.priority);
        const [entry, next] = matches;
        const model = request.model.provider + '/' + request.model.id;
        if (!entry) throw new Error('No model adapter accepts ' + model);
        if (entry.scope === next?.scope && entry.priority === next?.priority)
          throw new Error('Multiple model adapters accept ' + model);
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
