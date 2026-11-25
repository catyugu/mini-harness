import { getTraceable, type Context } from 'mini-harness/cordis';
import type { HostServices, PluginScope } from './scopes.ts';
import { pluginInstance, sessionAddress, sessionVisible } from './instance.ts';

/** Scope assigned by the host to this plugin instance. */
export function pluginScope(ctx: Context): PluginScope {
  return pluginInstance(ctx).scope;
}

/** Prepare a visible conversation and resolve its current service as the caller. */
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
  const scopes = ctx.get('harnessScopes')!;
  const key = `session:${id}` as const;
  await scopes.prepare(key, signal ? AbortSignal.any([signal, lifetime]) : lifetime);
  lifetime.throwIfAborted();
  if (!sessionVisible(ctx, id)) throw new Error('Conversation outside plugin scope');
  return getTraceable(ctx, scopes.require(key, name));
}
