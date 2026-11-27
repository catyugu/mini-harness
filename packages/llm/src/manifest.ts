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
  type Pull = Promise<IteratorResult<LlmEvent>>;
  let pull: Pull | undefined;
  let exhausted = false;
  let open!: (value: { iterator: AsyncIterator<LlmEvent>; signal: AbortSignal }) => void;
  let fail!: (reason: unknown) => void;
  const ready = new Promise<Parameters<typeof open>[0]>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  let stop!: () => void;
  const closed = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const work = owner.fiber.run(
    async (signal) => {
      const iterator = adapter.stream({ ...request, signal })[Symbol.asyncIterator]();
      signal.addEventListener('abort', stop, { once: true });
      open({ iterator, signal });
      try {
        if (!signal.aborted) await closed;
      } finally {
        signal.removeEventListener('abort', stop);
        const pending = pull?.catch(() => {});
        try {
          if (!exhausted) await iterator.return?.();
        } finally {
          await pending;
        }
      }
    },
    AbortSignal.any([activation, request.signal]),
  );
  void work.catch(fail);

  try {
    const { iterator, signal } = await ready;
    while (true) {
      signal.throwIfAborted();
      const next = await (pull = Promise.resolve(iterator.next()));
      pull = undefined;
      exhausted = Boolean(next.done);
      signal.throwIfAborted();
      if (exhausted) break;
      yield next.value;
    }
  } finally {
    stop();
    await work;
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
