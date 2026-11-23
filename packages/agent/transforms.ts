import type { AgentTransform, StepContext } from '@mini-harness/contracts/extensions';
import type { OrderedHook } from '@mini-harness/contracts/events';

export async function applyTransforms<Value, Context extends StepContext>(
  hooks: OrderedHook<AgentTransform<Value, Context>>[], value: Value, context: Context,
  validate: (value: Value) => void
): Promise<Value> {
  for (const { pluginId, transform } of hooks.sort((a, b) => a.order - b.order || a.pluginId.localeCompare(b.pluginId))) {
    context.signal.throwIfAborted();
    try {
      const result = await transform(value, context);
      if (result === undefined) continue;
      const snapshot: Value = JSON.parse(JSON.stringify(result));
      validate(snapshot);
      value = snapshot;
    } catch (error) {
      context.signal.throwIfAborted();
      throw new Error('Plugin ' + pluginId + ' failed to transform agent data', { cause: error });
    }
  }
  return value;
}
