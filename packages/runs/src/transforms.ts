import type { Context } from 'mini-harness/cordis';
import { entryFiber } from '@mini-harness/plugin-api/plugin-configuration';

interface AgentListener<Handler> {
  context: Context;
  callback: Handler;
}

type Transform<Value, Input> = AgentListener<
  (value: Value, context: Input) => Value | undefined | Promise<Value | undefined>
>;

async function invoke<Value, Input extends { signal: AbortSignal }>(
  { context, callback }: Transform<Value, Input>,
  value: Value,
  input: Input,
): Promise<Value | undefined> {
  const { signal, ...data } = input;
  signal.throwIfAborted();
  try {
    const result = await context.fiber.run(
      (signal) => callback(value, { ...data, signal } as Input),
      signal,
    );
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    const instanceId = entryFiber(context)?.entry?.options.id ?? 'fiber:' + context.fiber.uid;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error('Plugin ' + instanceId + ' could not prepare transformed data: ' + reason, {
      cause: error,
    });
  }
}

export async function applyTransforms<Value, Input extends { signal: AbortSignal }>(
  hooks: Transform<Value, Input>[],
  value: Value,
  input: Input,
): Promise<Value> {
  for (const hook of hooks) value = (await invoke(hook, value, input)) ?? value;
  input.signal.throwIfAborted();
  return value;
}

export async function recoverRequest<Value, Input extends { signal: AbortSignal }>(
  hooks: Transform<Value, Input>[],
  value: Value,
  input: Input,
): Promise<Value | undefined> {
  for (const hook of hooks) {
    const result = await invoke(hook, value, input);
    if (result !== undefined) return result;
  }
  input.signal.throwIfAborted();
}
