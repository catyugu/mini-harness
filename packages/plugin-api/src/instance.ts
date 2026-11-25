import { Context, getTraceable, type Entry } from 'mini-harness/cordis';
import type { HostServices, PluginScope, ScopeKey } from './scopes.js';

interface PluginInstance {
  pluginId: string;
  scope: PluginScope;
  scopeKey?: ScopeKey;
  trusted: boolean;
  writableConfig: boolean;
}

const identities = new WeakMap<Entry, PluginInstance>();

export function bindInstance(entry: Entry, identity: PluginInstance) {
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

/** Scope assigned by the host to this plugin instance. */
export function pluginScope(ctx: Context): PluginScope {
  return pluginInstance(ctx).scope;
}

/** Prepare a visible conversation before accessing a declared service as the caller. */
export async function sessionService<Name extends keyof HostServices & string>(
  ctx: Context,
  id: string,
  name: Name,
  signal?: AbortSignal,
) {
  const lifetime = ctx.fiber.signal;
  lifetime.throwIfAborted();
  if (!sessionAddress(ctx, id).length || !sessionVisible(ctx, id))
    throw new Error('Conversation outside plugin scope');
  let fiber = ctx.fiber;
  while (fiber.runtime && !(name in fiber.inject)) fiber = fiber.parent.fiber;
  if (!(name in fiber.inject)) throw new Error('Required service is not declared: ' + name);
  const scopes = ctx.get('harnessScopes')!;
  const key = `session:${id}` as const;
  await scopes.prepare(key, signal ? AbortSignal.any([signal, lifetime]) : lifetime);
  lifetime.throwIfAborted();
  if (!sessionVisible(ctx, id)) throw new Error('Conversation outside plugin scope');
  return getTraceable(ctx, scopes.require(key, name));
}
