/** A configuration handle whose namespace and lifetime are bound by the host. */
export interface PluginConfiguration {
  get<T = unknown>(key: string): T;
  set(key: string, value: unknown): Promise<void>;
  /** Apply a shallow field patch as one transaction. */
  patch(values: Record<string, unknown>): Promise<void>;
  subscribe<T = unknown>(key: string, listener: (value: T) => void): () => void;
}

import { FiberState, type Context, type Fiber } from 'mini-harness/cordis';
export function entryFiber(ctx: Context) {
  for (let fiber = ctx.fiber; fiber.runtime; fiber = fiber.parent.fiber) {
    if (fiber.entry) return fiber;
  }
}

export function pluginEntryFiber(ctx: Context): Fiber {
  const fiber = entryFiber(ctx);
  if (fiber) return fiber;
  throw new Error('Plugin configuration requires a Loader entry');
}

function fingerprint(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
}

export function pluginConfiguration(
  ctx: Context,
  write: (patch: Record<string, unknown>, signal: AbortSignal) => Promise<void>,
  committed: (notify: () => void) => () => void,
): PluginConfiguration {
  const fiber = pluginEntryFiber(ctx);
  const signal = AbortSignal.any([fiber.signal, ctx.fiber.signal]);
  const read = <T>(key: string): T => {
    signal.throwIfAborted();
    const values = fiber.effectiveConfig as Record<string, unknown> | undefined;
    if (!values) throw new Error('Plugin configuration is not available');
    return structuredClone(Object.hasOwn(values, key) ? values[key] : undefined) as T;
  };
  const patch = async (values: Record<string, unknown>) => {
    signal.throwIfAborted();
    if (fiber.state !== FiberState.ACTIVE)
      throw new Error('Plugin configuration cannot be written during setup');
    await write(values, signal);
  };
  return {
    get: read,
    patch,
    set: (key, value) => patch({ [key]: value }),
    subscribe<T>(key: string, listener: (value: T) => void) {
      let previous = fingerprint(read(key));
      return ctx.effect(() =>
        committed(() => {
          if (signal.aborted) return;
          const value = read<T>(key);
          const next = fingerprint(value);
          if (next === previous) return;
          previous = next;
          try {
            listener(value);
          } catch (error) {
            ctx.logger.error(error);
          }
        }),
      );
    },
  };
}
