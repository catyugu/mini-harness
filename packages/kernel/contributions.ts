import type { Context } from 'cordis';
import type { ServiceMap } from './services.js';

export interface ContributionSource {
  readonly context: Context;
  readonly pluginId: string;
  readonly instanceId: string;
  readonly scopeKey?: string;
  readonly signal: AbortSignal;
  visible(scopeId: string): boolean;
  depth(scopeId: string): number;
  service<Name extends keyof ServiceMap & string>(name: Name): NonNullable<ServiceMap[Name]>;
  run<T>(stage: string, work: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal): Promise<T>;
}

const trustedSources = new WeakSet<ContributionSource>();

export function bindContributionSource(source: ContributionSource, trusted: boolean): ContributionSource {
  Object.freeze(source);
  if (trusted) trustedSources.add(source);
  return source;
}

export function isTrustedContribution(source: ContributionSource): boolean {
  return trustedSources.has(source);
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

export type Transform<Value, Context> = (value: Value, context: Context) => Value | undefined | Promise<Value | undefined>;

export interface OrderedHook<Handler> {
  instanceId: string;
  order: number;
  invoke: Handler;
  assertActive?(scopeId: string): void;
}

export function orderHooks<T>(hooks: OrderedHook<T>[]) {
  return hooks.sort((a, b) => a.order - b.order || (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0));
}

export function scopedHook<Handler>(
  source: ContributionSource, stage: string, order: number,
  bind: (assertActive: (scopeId: string) => void) => Handler,
  listen: (hook: OrderedHook<Handler>, visible: (scopeId: string) => boolean) => () => void
) {
  if (!Number.isFinite(order)) throw new Error('Invalid contribution order for ' + stage);
  let registered = true;
  const visible = (id: string) => registered && source.visible(id);
  const assertActive = (id: string) => {
    if (!visible(id)) throw new Error('Plugin ' + source.instanceId + ' contribution is no longer available during ' + stage);
  };
  const dispose = listen({ instanceId: source.instanceId, order, assertActive, invoke: bind(assertActive) }, visible);
  return () => { registered = false; dispose(); };
}

export function orderedHook<Value, Context extends { signal: AbortSignal }, Result>(
  source: ContributionSource, stage: string, handler: (value: Value, context: Context) => Result | undefined | Promise<Result | undefined>,
  order: number, scopeOf: (context: Context) => string, listen: (hook: OrderedHook<typeof handler>, visible: (scopeId: string) => boolean) => () => void
) {
  if (typeof handler !== 'function') throw new Error('Invalid ' + stage + ' contribution');
  return scopedHook(source, stage, order, (assertActive) => (value, context) =>
    source.run(stage, async (signal) => {
      const scope = scopeOf(context);
      const { signal: _signal, ...input } = context;
      assertActive(scope);
      const result = await handler(structuredClone(value), { ...structuredClone(input), signal } as Context);
      assertActive(scope);
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result)) as Result;
    }, context.signal), listen);
}

export function decisionHook<Request extends { signal: AbortSignal }, Result>(
  source: ContributionSource, stage: string, handler: (request: Request) => Result | undefined | Promise<Result | undefined>,
  order: number, scopeOf: (request: Request) => string, listen: (hook: OrderedHook<typeof handler>, visible: (scopeId: string) => boolean) => () => void,
  validate: (decision: Result) => Result
) {
  if (typeof handler !== 'function') throw new Error('Invalid ' + stage + ' contribution');
  return scopedHook(source, stage, order, (assertActive) => (request) =>
    source.run(stage, async (signal) => {
      const scope = scopeOf(request);
      const { signal: _signal, ...input } = request;
      assertActive(scope);
      const decision = await handler({ ...structuredClone(input), signal } as Request);
      assertActive(scope);
      return decision === undefined ? undefined : validate(decision);
    }, request.signal), listen);
}

export async function firstDecision<Request, Result>(
  hooks: OrderedHook<(request: Request) => Result | undefined | Promise<Result | undefined>>[], request: Request
) {
  for (const { invoke } of orderHooks(hooks)) {
    const decision = await invoke(request);
    if (decision !== undefined) return decision;
  }
}
