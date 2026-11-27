import { isThinkingLevel, type ThinkingLevel, type ModelChoice } from '@mini-harness/llm/vocabulary';
import { DomainError } from '@mini-harness/platform/errors';
import type { ModelCatalogPort } from './api.ts';
import type { NativeMessage } from '@mini-harness/llm/api';

import type { ProviderModel } from '../shared/catalog.ts';

function supportsThinking(level: ThinkingLevel, capabilities: ProviderModel) {
  if (level === 'off') return true;
  return (
    isThinkingLevel(level) &&
    capabilities.reasoning &&
    (!capabilities.thinkingLevels || capabilities.thinkingLevels.includes(level))
  );
}

export function resolveThinking(
  capabilities: ProviderModel,
  explicit?: ThinkingLevel | null,
  inherited?: ThinkingLevel,
) {
  if (explicit === null) return undefined;
  if (explicit !== undefined) {
    if (!supportsThinking(explicit, capabilities))
      throw new DomainError(
        'invalid_input',
        'The selected model does not support thinking level: ' + explicit,
      );
    return explicit;
  }
  return inherited !== undefined && supportsThinking(inherited, capabilities) ? inherited : undefined;
}

export function selectModel(
  catalog: ModelCatalogPort,
  choices: readonly (ModelChoice | undefined)[],
  unavailable = 'Configure a model before sending a message',
) {
  for (const choice of choices) {
    if (!choice) continue;
    const resolved = catalog.resolve(choice);
    if (resolved) return resolved;
  }
  throw new DomainError('invalid_input', unavailable);
}

export function assertImageInput(capabilities: ProviderModel, count: number) {
  if (count && !capabilities.input.includes('image'))
    throw new DomainError(
      'invalid_input',
      'The selected model does not support image input. Choose an image-capable model and retry.',
    );
}

export function prepareModelMessages(capabilities: ProviderModel, messages: NativeMessage[]): NativeMessage[] {
  if (capabilities.input.includes('image')) return messages;
  return messages.map((message) => {
    if (
      message.role === 'assistant' ||
      !message.content.some(({ type }) => type === 'image')
    )
      return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'image' ? { type: 'text' as const, text: '[Image unavailable to this model]' } : part,
      ),
    };
  });
}
