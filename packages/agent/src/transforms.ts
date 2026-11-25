import type { Context } from 'mini-harness/cordis';
import { entryFiber } from '@mini-harness/plugin-api/plugin-configuration';

export interface AgentListener<Handler> {
  context: Context;
  callback: Handler;
}

export async function applyTransforms<
  Value,
  Input extends { sessionId: string; signal: AbortSignal },
  Result,
>(
  hooks: AgentListener<(value: Value, context: Input) => Result | undefined | Promise<Result | undefined>>[],
  value: Value,
  input: Input,
  validate: (result: Result) => Value,
): Promise<Value> {
  const { signal, ...data } = input;
  for (const { context, callback } of hooks) {
    signal.throwIfAborted();
    try {
      const result = await context.fiber.run(
        (signal) => callback(structuredClone(value), { ...structuredClone(data), signal } as Input),
        signal,
      );
      if (result !== undefined) value = validate(structuredClone(result));
    } catch (error) {
      signal.throwIfAborted();
      const instanceId = entryFiber(context)?.entry?.options.id ?? 'fiber:' + context.fiber.uid;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error('Plugin ' + instanceId + ' could not prepare transformed data: ' + reason, {
        cause: error,
      });
    }
  }
  signal.throwIfAborted();
  return value;
}
