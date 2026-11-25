import { Service, type Plugin } from 'mini-harness/cordis';
import { scopeChainOf, scopeOf, type ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { ModelCatalogPort, ModelSource } from '../server/api.ts';
import type { ModelSummary } from '../shared/catalog.ts';

export const metadata = {
  title: 'Model catalog',
  description: 'Aggregate model contributions from adapters and providers',
};

const plugin: Plugin.Object = {
  provide: ['harnessModels'],
  apply(ctx) {
    const sources = new Set<{
      source: ModelSource;
      priority: number;
      scope?: ScopeKey;
    }>();
    function selected(caller: import('mini-harness/cordis').Context) {
      const ancestry = [...scopeChainOf(scopeOf(caller)), undefined];
      return [...sources]
        .filter(({ scope }) => ancestry.includes(scope))
        .sort((a, b) => ancestry.indexOf(a.scope) - ancestry.indexOf(b.scope) || b.priority - a.priority)
        .map(({ source }) => source);
    }
    function merge(groups: ModelSummary[][]) {
      const models = new Map<string, ModelSummary>();
      for (const group of groups)
        for (const model of group) {
          const key = JSON.stringify([model.provider, model.id]);
          if (!models.has(key)) models.set(key, model);
        }
      return [...models.values()];
    }
    ctx.provide(
      'harnessModels',
      Service.track<ModelCatalogPort>({
        register(source, priority = 0) {
          const caller = Service.caller(this);
          const entry = { source, priority, scope: scopeOf(caller) };
          sources.add(entry);
          return () => sources.delete(entry);
        },
        list() {
          return merge(selected(Service.caller(this)).map((source) => source.list()));
        },
        async available() {
          return merge(
            await Promise.all(
              selected(Service.caller(this)).map((source) => source.available?.() ?? source.list()),
            ),
          );
        },
        resolve(choice) {
          for (const source of selected(Service.caller(this))) {
            const model = source.resolve(choice);
            if (model) return model;
          }
        },
        capabilities(choice) {
          for (const source of selected(Service.caller(this))) {
            const model = source.resolve(choice);
            if (model) return source.capabilities(model);
          }
        },
      }),
    );
  },
};

export default plugin;
