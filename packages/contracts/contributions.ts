import type { Context } from 'cordis';
import type { ServiceMap } from './plugin-sdk.js';

export interface ContributionSource {
  readonly context: Context;
  readonly pluginId: string;
  readonly instanceId: string;
  readonly scopeKey?: string;
  readonly signal: AbortSignal;
  visible(sessionId: string): boolean;
  depth(sessionId: string): number;
  service<Name extends keyof ServiceMap & string>(name: Name): NonNullable<ServiceMap[Name]>;
  run<T>(stage: string, work: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal): Promise<T>;
}

const register = Symbol.for('mini-harness.extension');

export interface Extension<Args extends unknown[], Result> {
  readonly [register]: (source: ContributionSource, ...args: Args) => Result;
}

/** Define a typed registration owned by a capability. The host supplies the source. */
export function extension<Args extends unknown[], Result>(
  mount: (source: ContributionSource, ...args: Args) => Result
): Extension<Args, Result> {
  return Object.freeze({ [register]: mount });
}

export function contribute<Args extends unknown[], Result>(
  source: ContributionSource, point: Extension<Args, Result>, args: Args
): Result {
  source.signal.throwIfAborted();
  return point[register](source, ...args);
}

export interface OrderedHook<Handler> {
  instanceId: string;
  order: number;
  transform: Handler;
}

export function orderHooks<T>(hooks: OrderedHook<T>[]) {
  return hooks.sort((a, b) => a.order - b.order || (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0));
}

export function orderedHook<Value, Context extends { signal: AbortSignal }>(
  source: ContributionSource, stage: string, handler: (value: Value, context: Context) => Value | undefined | Promise<Value | undefined>,
  order: number, listen: (hook: OrderedHook<typeof handler>, active: (sessionId: string) => boolean) => () => void
) {
  if (typeof handler !== 'function' || !Number.isFinite(order)) throw new Error('Invalid ' + stage + ' contribution');
  let registered = true;
  const dispose = listen({ instanceId: source.instanceId, order, transform(value, { signal, ...context }) {
    return source.run(stage, async (signal) => {
      if (!registered) throw new Error('Contribution is no longer registered');
      const result = await handler(structuredClone(value), { ...structuredClone(context), signal } as Context);
      if (!registered) throw new Error('Contribution is no longer registered');
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result)) as Value;
    }, signal);
  } }, (id) => registered && source.visible(id));
  return () => { registered = false; dispose(); };
}
