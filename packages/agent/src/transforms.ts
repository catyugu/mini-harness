import { orderHooks, type OrderedHook } from '@mini-harness/kernel/contributions';

export async function applyTransforms<Value, Context extends { sessionId: string; signal: AbortSignal }, Result>(
  hooks: OrderedHook<(value: Value, context: Context) => Result | undefined | Promise<Result | undefined>>[],
  value: Value, context: Context, validate: (result: Result) => Value
): Promise<Value> {
  for (const { instanceId, invoke } of orderHooks(hooks)) {
    context.signal.throwIfAborted();
    const result = await invoke(value, context);
    if (result === undefined) continue;
    try { value = validate(result); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error('Plugin ' + instanceId + ' could not prepare transformed data: ' + reason, { cause: error });
    }
  }
  context.signal.throwIfAborted();
  for (const hook of hooks) hook.assertActive?.(context.sessionId);
  return value;
}
