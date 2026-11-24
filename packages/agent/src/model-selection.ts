import { isThinkingLevel, type ThinkingLevel } from '@mini-harness/llm/vocabulary';
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
