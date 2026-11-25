import type { Context } from 'mini-harness/cordis';
import type { ScopeAddress } from './configuration.ts';

export function findInstance(ctx: Context) {
  for (let fiber = ctx.fiber; fiber.runtime; fiber = fiber.parent.fiber) {
    const entry = fiber.entry;
    if (!entry) continue;
    const { id: instanceId, live } = entry.options;
    const slash = instanceId.indexOf('/');
    return {
      instanceId,
      pluginId: instanceId.slice(slash + 1),
      scopeAddress: slash < 0 ? undefined : (instanceId.slice(0, slash) as ScopeAddress),
      writableConfig: live === true,
    };
  }
}

export function pluginInstance(ctx: Context) {
  const identity = findInstance(ctx);
  if (!identity) throw new Error('A server plugin instance is required');
  return identity;
}
