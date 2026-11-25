import { Context } from 'mini-harness/cordis';

/** Opaque, identity-compared runtime scope. Scope routing is not an access boundary. */
export type ScopeKey = object;
const scopeTag = Symbol('mini-harness.scope');
const parents = new WeakMap<ScopeKey, ScopeKey>();

export function createScopeKey(parent?: ScopeKey): ScopeKey {
  const key = {};
  if (parent) parents.set(key, parent);
  return key;
}

export function scopeParentOf(key: ScopeKey) {
  return parents.get(key);
}

/** Nearest scope first. */
export function scopeChainOf(key?: ScopeKey): ScopeKey[] {
  const chain: ScopeKey[] = [];
  for (; key; key = parents.get(key)) chain.push(key);
  return chain;
}

/** Tag a newly created context whose lifetime is already owned by Cordis. */
export function tagScope(ctx: Context, key: ScopeKey) {
  Object.defineProperty(ctx, scopeTag, { value: key });
  return ctx;
}

export function scopeOf(ctx: Context): ScopeKey | undefined {
  return (ctx as Context & { [scopeTag]?: ScopeKey })[scopeTag];
}

/** Route to unscoped listeners and listeners on the target's ancestry. */
export function scopeTarget(base: Context, key = scopeOf(base)) {
  const chain = scopeChainOf(key);
  const filter = base[Context.filter];
  return base.extend({
    [Context.filter](ctx: Context) {
      const scope = scopeOf(ctx);
      return (!filter || filter.call(base, ctx)) && (!scope || chain.includes(scope));
    },
  });
}

/** Named contribution layers shared by registries. */
export class ScopedLayers<T> {
  private readonly layers = new Map<ScopeKey | undefined, Map<string, T>>();

  add(scope: ScopeKey | undefined, name: string, value: T) {
    const layer = this.layers.get(scope) ?? new Map<string, T>();
    if (layer.has(name)) throw new Error('Duplicate entry in scope: ' + name);
    layer.set(name, value);
    this.layers.set(scope, layer);
    return () => {
      if (layer.get(name) !== value) return;
      layer.delete(name);
      if (!layer.size) this.layers.delete(scope);
    };
  }

  chain(scope?: ScopeKey) {
    return [...scopeChainOf(scope), undefined].flatMap((key) => {
      const layer = this.layers.get(key);
      return layer ? [layer] : [];
    });
  }
}
