import { isThinkingLevel, type ThinkingLevel, type ModelChoice } from '@mini-harness/llm/vocabulary';
import { DomainError } from '@mini-harness/platform/errors';
import type { ModelCatalogPort } from '@mini-harness/models/api';

type Capabilities = ReturnType<ModelCatalogPort['capabilities']>;

function supportsThinking(level: ThinkingLevel, capabilities: Capabilities) {
  if (level === 'off') return true;
  return isThinkingLevel(level) &&
    capabilities?.reasoning && (!capabilities.thinkingLevels || capabilities.thinkingLevels.includes(level));
}

export function resolveThinking(capabilities: Capabilities, explicit?: ThinkingLevel | null, inherited?: ThinkingLevel) {
  if (explicit === null) return undefined;
  if (explicit !== undefined) {
    if (!supportsThinking(explicit, capabilities))
      throw new DomainError('invalid_input', 'The selected model does not support thinking level: ' + explicit);
    return explicit;
  }
  return inherited !== undefined && supportsThinking(inherited, capabilities) ? inherited : undefined;
}

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
