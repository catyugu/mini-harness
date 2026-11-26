import type {
  LlmAdapter,
  LlmRequest,
  NativeContent,
  NativeMessage,
  NativeUsage,
} from '@mini-harness/llm/api';
import type { ProviderModel } from '@mini-harness/models/catalog';
import type { ContextOccupancy } from '../shared/state.ts';

export function textTokens(text: string) {
  // CJK and code punctuation tend to tokenize more densely than Latin prose.
  let units = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    units += point > 0x2e7f ? 4 : point > 0x7f || /[\p{P}\p{S}]/u.test(character) ? 2 : 1;
  }
  return Math.ceil(units / 4);
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

export function usageInput(usage: NativeUsage) {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

export class TokenMeter {
  private readonly costs = new WeakMap<NativeMessage, number>();
  private readonly calibrations = new WeakMap<LlmAdapter, Map<string, number>>();

  message(message: NativeMessage): number {
    let tokens = this.costs.get(message);
    if (tokens === undefined) {
      tokens = messageTokens(message);
      this.costs.set(message, tokens);
    }
    return tokens;
  }

  async measure(
    request: LlmRequest,
    capabilities?: ProviderModel,
    adapter?: LlmAdapter | null,
    count = true,
  ): Promise<ContextOccupancy> {
    let measured;
    try {
      measured = count ? await adapter?.countInputTokens?.(request) : undefined;
    } catch {
      request.signal.throwIfAborted();
    }
    const exact =
      measured &&
      [measured.system, measured.tools, measured.messages].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      );
    const scale = adapter ? (this.calibrations.get(adapter)?.get(key(request)) ?? 1) : 1;
    let counts;
    if (exact && measured) counts = measured;
    else {
      counts = {
        system: Math.ceil(textTokens(request.systemPrompt) * scale),
        tools: request.tools?.length ? Math.ceil(textTokens(JSON.stringify(request.tools)) * scale) : 0,
        messages: Math.ceil(
          request.messages.reduce((sum, message) => sum + this.message(message), 0) * scale,
        ),
      };
    }
    const window = capabilities?.contextWindow;
    const output = request.maxTokens ?? capabilities?.maxTokens;
    const margin = window && Math.min(4096, Math.max(16, Math.ceil(window * (exact ? 0.01 : 0.04))));
    const budget =
      window !== undefined && output !== undefined && margin !== undefined
        ? Math.max(0, window - output - margin)
        : undefined;
    return {
      ...counts,
      model: request.model,
      total: counts.system + counts.tools + counts.messages,
      budget,
      window,
      estimated: !exact,
    };
  }

  calibrate(
    request: Pick<LlmRequest, 'model'>,
    occupancy: ContextOccupancy,
    adapter: LlmAdapter,
    usage: NativeUsage,
  ) {
    const actual = usageInput(usage);
    if (!occupancy.estimated || !occupancy.total || actual < 64) return;
    let models = this.calibrations.get(adapter);
    if (!models) this.calibrations.set(adapter, (models = new Map()));
    const name = key(request);
    const previous = models.get(name) ?? 1;
    const observed = Math.min(4, Math.max(0.5, (actual / occupancy.total) * previous));
    models.set(name, previous * 0.65 + observed * 0.35);
  }
}

function key({ model }: Pick<LlmRequest, 'model'>) {
  return JSON.stringify([model.provider, model.id]);
}
