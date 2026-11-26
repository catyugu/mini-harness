import type {
  InputMeasurement,
  InputTokenCounts,
  LlmAdapter,
  LlmRequest,
  NativeContent,
  NativeMessage,
} from '@mini-harness/llm/api';
import type { SessionLogPort } from '@mini-harness/sessions/log-api';
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
  let size = 0,
    cost = 0;
  for (const character of text) {
    cost += units(character);
    if (cost > budget * 4) break;
    size += character.length;
  }
  return size;
}

function partTokens(part: NativeContent) {
  switch (part.type) {
    case 'image':
      return Math.min(4096, 256 + Math.ceil(part.data.length / 4096));
    case 'text':
      return textTokens(part.text);
    case 'thinking':
      return textTokens(part.thinking);
    case 'toolCall':
      return 8 + textTokens(part.name) + textTokens(JSON.stringify(part.arguments));
  }
}

export function messageTokens(message: NativeMessage) {
  return (
    4 +
    (typeof message.content === 'string'
      ? textTokens(message.content)
      : message.content.reduce((sum, part) => sum + partTokens(part), 0)) +
    (message.role === 'toolResult' ? textTokens(message.toolName) + 4 : 0)
  );
}

export const totalTokens = (counts: InputTokenCounts) => counts.system + counts.tools + counts.messages;

export function estimate(request: Pick<LlmRequest, 'systemPrompt' | 'tools' | 'messages'>): InputTokenCounts {
  return {
    system: textTokens(request.systemPrompt),
    tools: request.tools?.length ? textTokens(JSON.stringify(request.tools)) : 0,
    messages: request.messages.reduce((sum, message) => sum + messageTokens(message), 0),
  };
}

/** Use the newest usable same-model input observation. The raw estimate is reconstructed
 * once from its exact snapshot so calibration never compounds a previous correction. */
export function calibration(
  log: Pick<SessionLogPort, 'entries' | 'requestSnapshot'>,
  model: LlmRequest['model'],
) {
  const inputs = new Map<string, number>();
  for (const entry of log.entries().reverse()) {
    if (entry.type === 'model-attempt' && entry.usage && !inputs.has(entry.requestId)) {
      const { input, cacheRead, cacheWrite } = entry.usage;
      const actual = input + cacheRead + cacheWrite;
      if (Number.isFinite(actual) && actual > 0) inputs.set(entry.requestId, actual);
    }
    if (
      entry.type !== 'model-request' ||
      !entry.request.inputMeasurement?.estimated ||
      entry.request.model.provider !== model.provider ||
      entry.request.model.id !== model.id
    )
      continue;
    const actual = inputs.get(entry.id);
    if (actual === undefined) continue;
    const raw = totalTokens(estimate(log.requestSnapshot(entry.id)));
    if (raw > 0) return actual / raw;
  }
  return 1;
}

export type MeasuredRequest = LlmRequest & { maxTokens: number; inputMeasurement: InputMeasurement };

export async function measure(
  request: LlmRequest,
  capability: ProviderModel,
  adapter: LlmAdapter,
  scale = 1,
): Promise<MeasuredRequest> {
  const window = capability.contextWindow;
  const maxTokens = request.maxTokens ?? capability.maxTokens;
  if (
    !Number.isSafeInteger(window) ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    maxTokens > capability.maxTokens ||
    window <= maxTokens
  )
    throw new DomainError(
      'invalid_input',
      'Configure a valid context window and output limit for ' + request.model.id,
    );
  const prepared = { ...request, maxTokens };
  const exact = await adapter.countInputTokens?.(prepared);
  if (
    exact &&
    ![exact.system, exact.tools, exact.messages].every((count) => Number.isSafeInteger(count) && count >= 0)
  )
    throw new Error('Invalid adapter input token counts');
  const raw = exact ?? estimate(request);
  const counts = exact ?? {
    system: Math.ceil(raw.system * scale),
    tools: Math.ceil(raw.tools * scale),
    messages: Math.ceil(raw.messages * scale),
  };
  const budget = window - maxTokens - Math.min(4096, Math.max(16, Math.ceil(window * (exact ? 0.01 : 0.04))));
  if (budget <= 0) throw new DomainError('invalid_input', 'No input capacity after reserving model output');
  return { ...prepared, inputMeasurement: { ...counts, window, budget, estimated: !exact } };
}
