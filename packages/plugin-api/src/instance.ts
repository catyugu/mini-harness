import { Context, type FiberEntry } from 'mini-harness/cordis';
import type { PluginScope, ScopeKey } from './scopes.js';

interface PluginInstance {
  pluginId: string;
  scope: PluginScope;
  scopeKey?: ScopeKey;
  trusted: boolean;
  writableConfig: boolean;
}

const identities = new WeakMap<FiberEntry, PluginInstance>();

export function bindInstance(entry: FiberEntry, identity: PluginInstance) {
  identities.set(entry, Object.freeze(identity));
}

export function pluginInstance(ctx: Context) {
  for (let fiber = ctx.fiber; fiber.runtime; fiber = fiber.parent.fiber) {
    if (!fiber.entry) continue;
    const identity = identities.get(fiber.entry);
    if (identity) return { ...identity, instanceId: fiber.entry.options.id };
  }
  throw new Error('A server plugin instance is required');
}

export function sessionVisible(ctx: Context, id: string) {
  const scope = pluginInstance(ctx).scopeKey;
  return !scope || sessionAddress(ctx, id).includes(scope);
}

export function sessionAddress(ctx: Context, id: string) {
  return ctx.get('harnessScopes')?.address(`session:${id}`) ?? [];
}

export function sessionEvent(ctx: Context, id: string) {
  const scopes = sessionAddress(ctx, id);
  return scopedEvent(ctx, scopes);
}

export function scopedEvent(ctx: Context, scopes: readonly string[]) {
  return ctx.extend({
    [Context.filter]: (listener: Context) => {
      for (let fiber = listener.fiber; fiber.runtime; fiber = fiber.parent.fiber) {
        const identity = fiber.entry && identities.get(fiber.entry);
        if (identity) return !identity.scopeKey || scopes.includes(identity.scopeKey);
      }
      return true;
    },
  });
}
