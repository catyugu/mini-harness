import type { InputMeasurement, LlmAdapter, LlmRequest, NativeContent, NativeMessage } from '@mini-harness/llm/api';
import type { ProviderModel } from '@mini-harness/models/catalog';
import { DomainError } from '@mini-harness/platform/errors';

function units(character: string) {
  const point = character.codePointAt(0)!;
  return point > 0x2e7f ? 4 : point > 0x7f || /[\p{P}\p{S}]/u.test(character) ? 2 : 1;
}

export function textTokens(text: string) {
  let total = 0;
  for (const character of text) total += units(character);
  return Math.ceil(total / 4);
}

/** Split text once at an estimated token budget, without cutting Unicode characters. */
export function tokenPrefix(text: string, budget: number) {
  let size = 0, cost = 0;
  for (const character of text) {
    cost += units(character);
    if (cost > budget * 4) break;
    size += character.length;
  }
  return size;
}

function partTokens(part: NativeContent) {
  switch (part.type) {
    case 'image': return Math.min(4096, 256 + Math.ceil(part.data.length / 4096));
    case 'text': return textTokens(part.text);
    case 'thinking': return textTokens(part.thinking);
    case 'toolCall': return 8 + textTokens(part.name) + textTokens(JSON.stringify(part.arguments));
  }
}

export function messageTokens(message: NativeMessage) {
  return 4 + (typeof message.content === 'string'
    ? textTokens(message.content)
    : message.content.reduce((sum, part) => sum + partTokens(part), 0))
    + (message.role === 'toolResult' ? textTokens(message.toolName) + 4 : 0);
}

export const totalTokens = (counts: InputMeasurement) => counts.system + counts.tools + counts.messages;

export type MeasuredRequest = LlmRequest & { maxTokens: number; inputMeasurement: InputMeasurement };

export async function measure(request: LlmRequest, capability: ProviderModel, adapter: LlmAdapter): Promise<MeasuredRequest> {
  const window = capability.contextWindow;
  const maxTokens = request.maxTokens ?? capability.maxTokens;
  if (!Number.isSafeInteger(window) || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > capability.maxTokens || window <= maxTokens)
    throw new DomainError('invalid_input', 'Configure a valid context window and output limit for ' + request.model.id);
  const prepared = { ...request, maxTokens };
  const exact = await adapter.countInputTokens?.(prepared);
  if (exact && ![exact.system, exact.tools, exact.messages].every((count) => Number.isSafeInteger(count) && count >= 0))
    throw new Error('Invalid adapter input token counts');
  const counts = exact ?? {
    system: textTokens(request.systemPrompt),
    tools: request.tools?.length ? textTokens(JSON.stringify(request.tools)) : 0,
    messages: request.messages.reduce((sum, message) => sum + messageTokens(message), 0),
  };
  const budget = window - maxTokens - Math.min(4096, Math.max(16, Math.ceil(window * (exact ? 0.01 : 0.04))));
  if (budget <= 0) throw new DomainError('invalid_input', 'No input capacity after reserving model output');
  return { ...prepared, inputMeasurement: { ...counts, window, budget, estimated: !exact } };
}
