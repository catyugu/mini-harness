import type { ModelChoice } from '#mini-harness/contracts/conversation.js';
import type { ModelCatalogPort } from '#mini-harness/contracts/models.js';

export function selectModel(catalog: ModelCatalogPort, options: {
  explicit?: ModelChoice;
  stored?: ModelChoice;
  global: ModelChoice;
  child: boolean;
}) {
  const { explicit, stored, global, child } = options;
  if (explicit) {
    const selected = catalog.resolve(explicit);
    if (!selected) throw new Error('Unknown model: ' + explicit.provider + '/' + explicit.id);
    return selected;
  }
  const choices = child ? [stored, global] : [global, stored];
  for (const choice of choices) {
    if (!choice?.provider) continue;
    const selected = catalog.resolve(choice);
    if (selected) return selected;
  }
  throw new Error('Configure a model before sending a message');
}
