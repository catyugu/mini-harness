import { DomainError } from '@mini-harness/platform/errors';
import { isThinkingLevel } from './vocabulary.ts';

export function validateModelOptions(model: unknown, thinkingLevel: unknown) {
  if (thinkingLevel !== undefined && thinkingLevel !== null && !isThinkingLevel(thinkingLevel))
    throw new DomainError('invalid_input', 'Invalid thinking level');
  if (model === undefined) return;
  if (
    !model ||
    typeof model !== 'object' ||
    !('provider' in model) ||
    !('id' in model) ||
    typeof model.provider !== 'string' ||
    typeof model.id !== 'string' ||
    !model.provider ||
    !model.id ||
    model.provider.length > 160 ||
    model.id.length > 160
  )
    throw new DomainError('invalid_input', 'Invalid model choice');
}
