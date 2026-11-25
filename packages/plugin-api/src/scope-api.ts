import { getTraceable, type Context } from 'mini-harness/cordis';
import type { ScopeKey } from './scopes.ts';
import { findInstance } from './instance.ts';

/** The owning Entry's scope, or undefined for an application Entry. */
export function pluginScope(ctx: Context): ScopeKey | undefined {
  return findInstance(ctx)?.scopeKey;
}

/** Resolve the current service for a conversation, including scoped overrides. */
export async function sessionService<Name extends keyof Context & string>(
  ctx: Context,
  id: string,
  name: Name,
  signal?: AbortSignal,
) {
  const lifetime = ctx.fiber.signal;
  lifetime.throwIfAborted();
  const scopes = ctx.get('harnessScopes')!;
  const key = `session:${id}` as const;
  await scopes.prepare(key, signal ? AbortSignal.any([signal, lifetime]) : lifetime);
  lifetime.throwIfAborted();
  return getTraceable(ctx, scopes.require(key, name));
}
