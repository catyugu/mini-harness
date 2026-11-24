import type { AgentTransform, StepContext } from '@mini-harness/contracts/extensions';
import { orderHooks, type OrderedHook } from '@mini-harness/contracts/contributions';

export async function applyTransforms<Value, Context extends StepContext>(
  hooks: OrderedHook<AgentTransform<Value, Context>>[], value: Value, context: Context,
  validate: (value: Value) => void
): Promise<Value> {
  for (const { instanceId, transform } of orderHooks(hooks)) {
    context.signal.throwIfAborted();
    const result = await transform(value, context);
    if (result === undefined) continue;
    try { validate(result); }
    catch (error) { throw new Error('Plugin ' + instanceId + ' returned invalid transformed data', { cause: error }); }
    value = result;
  }
  return value;
}
