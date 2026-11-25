import { Service, type Plugin } from 'mini-harness/cordis';
import type { LlmAdapter, LlmPort } from './api.ts';

export const metadata = {
  title: 'Model transport',
  description: 'Select a registered adapter to stream a model response',
};

const plugin: Plugin.Object = {
  provide: ['harnessLlm'],
  apply(ctx) {
    const adapters = new Set<{ adapter: LlmAdapter; priority: number; owner: AbortSignal }>();
    const llm = Service.track<LlmPort>({
      register(adapter, priority = 0) {
        const entry = { adapter, priority, owner: Service.caller(this).fiber.signal };
        adapters.add(entry);
        return () => adapters.delete(entry);
      },
      async *stream(request) {
        request.signal.throwIfAborted();
        const matches = [...adapters]
          .filter(({ adapter, owner }) => !owner.aborted && adapter.accepts(request.model))
          .sort((a, b) => b.priority - a.priority);
        const [entry, next] = matches;
        const model = request.model.provider + '/' + request.model.id;
        if (!entry) throw new Error('No model adapter accepts ' + model);
        if (entry.priority === next?.priority) throw new Error('Multiple model adapters accept ' + model);
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
