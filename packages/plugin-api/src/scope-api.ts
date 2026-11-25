import { getTraceable, type Context } from 'mini-harness/cordis';
import type { HostServices, PluginScope } from './scopes.js';
import { pluginInstance, sessionAddress, sessionVisible } from './instance.js';

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
