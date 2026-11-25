import { Service, type Context, type Plugin } from 'mini-harness/cordis';
import { rankScoped, sameRank, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { LlmAdapter } from '@mini-harness/llm/api';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelCatalogPort, ModelSource } from '../server/api.ts';
import type { ModelSummary } from '../shared/catalog.ts';

export const metadata = {
  title: 'Model catalog',
  description: 'Aggregate model contributions from adapters and providers',
};

interface Contribution {
  source: ModelSource;
  adapter: LlmAdapter;
  priority: number;
  owner: AbortSignal;
  scope?: ScopeKey;
}

const plugin: Plugin.Object = {
  inject: ['harnessLlm'],
  provide: ['harnessModels'],
  apply(ctx) {
    const sources = new Set<Contribution>();
    const changed = () => ctx.get('harnessChanges')?.invalidate('models');
    function visible(caller: Context) {
      return rankScoped(scopeOf(caller), sources).filter(({ owner }) => !owner.aborted);
    }
    function match(caller: Context, entries: Contribution[], choice: ModelChoice) {
      const matches = entries.flatMap((entry) => {
        const model = entry.source.resolve(choice);
        return model ? [{ entry, model }] : [];
      });
      const [winner, next] = matches;
      if (!winner || sameRank(winner.entry, next?.entry)) return;
      const adapter = caller.get('harnessLlm')?.select(winner.model);
      if (!adapter) return;
      // An adapter-only override intentionally reuses the selected catalog's metadata.
      // A paired adapter must instead agree with its own model contribution.
      if (adapter !== winner.entry.adapter && entries.some((entry) => entry.adapter === adapter)) return;
      return winner;
    }
    function merge(caller: Context, entries: Contribution[], groups: ModelSummary[][]) {
      const models = new Map<string, ModelSummary>();
      for (const [index, group] of groups.entries()) {
        for (const model of group) {
          const key = JSON.stringify([model.provider, model.id]);
          if (!models.has(key) && match(caller, entries, model)?.entry === entries[index])
            models.set(key, model);
        }
      }
      return [...models.values()];
    }
    ctx.provide(
      'harnessModels',
      Service.track<ModelCatalogPort>({
        register(source, adapter, priority = 0) {
          const caller = Service.caller(this);
          const entry = { source, adapter, priority, owner: caller.fiber.signal, scope: scopeOf(caller) };
          const release = caller.harnessLlm.register(adapter, priority);
          sources.add(entry);
          changed();
          return () => {
            if (!sources.delete(entry)) return;
            release();
            changed();
          };
        },
        list() {
          const caller = Service.caller(this);
          const entries = visible(caller);
          return merge(
            caller,
            entries,
            entries.map(({ source }) => source.list()),
          );
        },
        async available() {
          const caller = Service.caller(this);
          const entries = visible(caller);
          const groups = await Promise.all(
            entries.map(({ source }) => source.available?.() ?? source.list()),
          );
          return merge(caller, entries, groups);
        },
        resolve(choice) {
          const caller = Service.caller(this);
          return match(caller, visible(caller), choice)?.model;
        },
        capabilities(choice) {
          const caller = Service.caller(this);
          const selected = match(caller, visible(caller), choice);
          return selected?.entry.source.capabilities(selected.model);
        },
      }),
    );
  },
};

export default plugin;
