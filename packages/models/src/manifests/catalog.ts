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
    ctx.inject(['harnessChanges'], (scope) => {
      scope.effect(() => scope.harnessChanges.register('models'));
    });
    const project = () => ctx.get('harnessChanges')?.invalidate('models');
    let dirty: 'catalog' | 'auth' | undefined;
    let pairing = 0;
    const flush = () => {
      if (!dirty || pairing || ctx.get('harnessProfileConfig')?.stable === false) return;
      const kind = dirty;
      dirty = undefined;
      if (kind === 'catalog')
        void ctx.parallel('models/catalog-changed').catch((error) => ctx.logger.warn(String(error)));
      else project();
    };
    const changed = (kind: 'catalog' | 'auth') => {
      if (dirty !== 'catalog') dirty = kind;
      flush();
    };
    ctx.on('models/catalog-changed', project);
    ctx.on('models/source-changed', changed);
    ctx.on('llm/adapters-changed', () => changed('catalog'));
    ctx.on('profile/graph-settled', flush);
    function visible(caller: Context) {
      return rankScoped(scopeOf(caller), sources).filter(({ owner }) => !owner.aborted);
    }
    function match(caller: Context, entries: Contribution[], choice: ModelChoice) {
      const matches = entries.flatMap((entry) => {
        if (entry.owner.aborted || !sources.has(entry)) return [];
        const resolved = entry.source.resolve(choice);
        return resolved ? [{ entry, resolved }] : [];
      });
      const [winner, next] = matches;
      if (!winner || sameRank(winner.entry, next?.entry)) return;
      const adapter = caller.get('harnessLlm')?.select(winner.resolved.model);
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
          const llm = caller.get('harnessLlm');
          if (!llm) throw new Error('Model transport is unavailable in this scope');
          pairing++;
          sources.add(entry);
          let release: () => void;
          try {
            release = llm.register(adapter, priority);
            changed('catalog');
          } catch (error) {
            sources.delete(entry);
            throw error;
          } finally {
            pairing--;
            flush();
          }
          return () => {
            if (!sources.delete(entry)) return;
            pairing++;
            try {
              release();
            } finally {
              pairing--;
              changed('catalog');
            }
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
          return match(caller, visible(caller), choice)?.resolved;
        },
      }),
    );
  },
};

export default plugin;
