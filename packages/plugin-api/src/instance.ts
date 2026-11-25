import type { Context, FiberEntry } from 'mini-harness/cordis';
import type { ScopeAddress } from './configuration.ts';

interface PluginInstance {
  pluginId: string;
  scopeAddress?: ScopeAddress;
  writableConfig: boolean;
}

const identities = new WeakMap<FiberEntry, PluginInstance>();
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
