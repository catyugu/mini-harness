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
    typeof model.provider !== 'string' ||
    !model.provider ||
    model.provider.length > 160 ||
    ('id' in model &&
      model.id !== undefined &&
      (typeof model.id !== 'string' || !model.id || model.id.length > 160))
  )
    throw new DomainError('invalid_input', 'Invalid model choice');
}
