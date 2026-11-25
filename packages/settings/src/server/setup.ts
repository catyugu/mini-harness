import type { Context } from 'mini-harness/cordis';
import type { ProfileConfiguration } from '@mini-harness/plugin-api/configuration';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);

/** Only the declared form fields reach settings clients. Private values survive form edits. */
function selectConfig(values: ObjectValue, schema: Record<string, any> | undefined, visible: boolean): ObjectValue {
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
    const property = schema?.properties?.[key];
    if (!property) return visible ? [] : [[key, value]];
    if (object(value) && property.properties) {
      const selected = selectConfig(value, property, visible);
      return Object.keys(selected).length ? [[key, selected]] : [];
    }
    return visible ? [[key, value]] : [];
  }));
}

function mergeConfig(privateValues: ObjectValue, patch: ObjectValue): ObjectValue {
  return { ...privateValues, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key,
    object(privateValues[key]) && object(value) ? mergeConfig(privateValues[key], value) : value,
  ])) };
}

export function setup(ctx: Context) {
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('settings'));
  ctx.effect(() => ctx.harnessSettingsStore.subscribe(() => changes.invalidate('settings')));
  const { harnessSettingsStore: store, harnessMutations: mutations, harnessRoutes: routes } = ctx;
  const schema = (id: string, scope?: ScopeKey) => {
    const plugin = ctx.get('harnessPluginCatalog')?.metadata().find((item) => item.id === id);
    return plugin?.instances?.find((item) => item.scope === (scope ?? 'application'))?.configSchema ?? plugin?.configSchema;
  };
  const view = (settings: ProfileConfiguration) => {
    const result = structuredClone(settings);
    for (const [id, entry] of Object.entries(result.entries))
      if (entry.config) entry.config = selectConfig(entry.config, schema(id), true);
    for (const [scope, selection] of Object.entries(result.scopes))
      for (const [id, entry] of Object.entries(selection?.entries ?? {}))
        if (entry.config) entry.config = selectConfig(entry.config, schema(id, scope as ScopeKey), true);
    return result;
  };
  const restore = (patch: unknown) => {
    if (!object(patch)) return patch;
    const current = store.settings;
    const entries = (values: unknown, scope?: ScopeKey) => {
      if (!object(values)) return;
      for (const [id, entry] of Object.entries(values)) {
        if (!object(entry)) continue;
        const old = scope ? current.scopes[scope]?.entries?.[id] : current.entries[id];
        if (!old?.config || (entry.name !== undefined && entry.name !== old.name)) continue;
        if (object(entry.config)) entry.config = mergeConfig(selectConfig(old.config, schema(id, scope), false), entry.config);
        else if (scope && entry.config === undefined) entry.config = old.config;
      }
    };
    entries(patch.entries);
    if (object(patch.scopes))
      for (const [key, scope] of Object.entries(patch.scopes))
        if (object(scope)) entries(scope.entries, key as ScopeKey);
    return patch;
  };
  ctx.effect(() => routes.register('GET', '/api/settings', () => view(store.settings)));
  ctx.effect(() =>
    routes.register('PATCH', '/api/settings', async ({ body }) => {
      const patch = await body();
      return mutations.run(async () => view(await store.update(restore(patch))));
    }),
  );
}
