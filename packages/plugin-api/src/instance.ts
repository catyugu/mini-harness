import { Context, type FiberEntry } from 'mini-harness/cordis';
import type { PluginScope, ScopeKey } from './scopes.ts';

interface PluginInstance {
  pluginId: string;
  scope: PluginScope;
  scopeKey?: ScopeKey;
  writableConfig: boolean;
}

const identities = new WeakMap<FiberEntry, PluginInstance>();
const agentScope = Symbol('agentScope');

/** Attach the runtime conversation identity without granting a plugin identity. */
export function agentContext(ctx: Context, sessionId: string) {
  return ctx.extend({ [agentScope]: `session:${sessionId}` });
}

export function agentScopeOf(ctx: Context): ScopeKey | undefined {
  return (ctx as Context & { [agentScope]?: ScopeKey })[agentScope];
}

export function bindInstance(entry: FiberEntry, identity: PluginInstance) {
  identities.set(entry, Object.freeze(identity));
}

export function findInstance(ctx: Context) {
  for (let fiber = ctx.fiber; fiber.runtime; fiber = fiber.parent.fiber) {
    if (!fiber.entry) continue;
    const identity = identities.get(fiber.entry);
    if (identity) return { ...identity, instanceId: fiber.entry.options.id };
  }
}

export function pluginInstance(ctx: Context) {
  const identity = findInstance(ctx);
  if (!identity) throw new Error('A server plugin instance is required');
  return identity;
}

export function sessionVisible(ctx: Context, id: string) {
  const runScope = agentScopeOf(ctx);
  const owner = runScope ? findInstance(ctx) : pluginInstance(ctx);
  const address = sessionAddress(ctx, id);
  return [runScope, owner?.scopeKey].every(
    (scope) => !scope || scope === `session:${id}` || address.includes(scope),
  );
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
      const runScope = agentScopeOf(listener);
      if (runScope && !scopes.includes(runScope)) return false;
      for (let fiber = listener.fiber; fiber.runtime; fiber = fiber.parent.fiber) {
        const identity = fiber.entry && identities.get(fiber.entry);
        if (identity) return !identity.scopeKey || scopes.includes(identity.scopeKey);
      }
      return true;
    },
  });
}
