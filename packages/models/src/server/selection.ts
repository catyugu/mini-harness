import { isThinkingLevel, type ThinkingLevel, type ModelChoice } from '@mini-harness/llm/vocabulary';
import { DomainError } from '@mini-harness/platform/errors';
import type { ModelCatalogPort } from './api.ts';
import type { NativeMessage } from '@mini-harness/llm/api';

type Capabilities = ReturnType<ModelCatalogPort['capabilities']>;

function supportsThinking(level: ThinkingLevel, capabilities: Capabilities) {
  if (level === 'off') return true;
  return (
    isThinkingLevel(level) &&
    capabilities?.reasoning &&
    (!capabilities.thinkingLevels || capabilities.thinkingLevels.includes(level))
  );
}

export function resolveThinking(
  capabilities: Capabilities,
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
  options: {
    explicit?: ModelChoice;
    stored?: ModelChoice;
    fallback?: ModelChoice;
    preferStored?: boolean;
    thinkingLevel?: ThinkingLevel | null;
    inherited?: ThinkingLevel;
    unavailable?: string;
  },
) {
  const { explicit, stored, fallback, preferStored, thinkingLevel, inherited, unavailable } = options;
  const choices = explicit ? [explicit] : preferStored ? [stored, fallback] : [fallback, stored];
  for (const choice of choices) {
    if (!choice?.provider) continue;
    const model = catalog.resolve(choice);
    if (model)
      return { model, thinkingLevel: resolveThinking(catalog.capabilities(model), thinkingLevel, inherited) };
  }
  throw new DomainError(
    'invalid_input',
    unavailable ??
      (explicit
        ? 'Unknown model: ' + explicit.provider + '/' + explicit.id
        : 'Configure a model before sending a message'),
  );
}

export function assertImageInput(capabilities: Capabilities, count: number) {
  if (count && !capabilities?.input.includes('image'))
    throw new DomainError(
      'invalid_input',
      'The selected model does not support image input. Choose an image-capable model and retry.',
    );
}

export function prepareModelMessages(capabilities: Capabilities, messages: NativeMessage[]): NativeMessage[] {
  if (capabilities?.input.includes('image')) return messages;
  return messages.map((message) => {
    if (message.role === 'assistant' || !message.content.some(({ type }) => type === 'image')) return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'image' ? { type: 'text' as const, text: '[Image unavailable to this model]' } : part,
      ),
    };
  });
}
