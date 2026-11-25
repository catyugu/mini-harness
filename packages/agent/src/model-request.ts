import { setTimeout as sleep } from 'node:timers/promises';
import type { LlmPort, LlmRequest, NativeAssistantMessage } from '@mini-harness/llm/api';
import type { ModelFailure, ModelRetry } from './events.js';

function failedMessage({ model, signal }: LlmRequest, error: unknown, partial = ''): NativeAssistantMessage {
  return {
    role: 'assistant',
    content: partial ? [{ type: 'text', text: partial }] : [],
    timestamp: Date.now(),
    provider: model.provider,
    model: model.id,
    stopReason: signal.aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

export async function requestModel(
  llm: LlmPort,
  request: LlmRequest,
  options: {
    delta(text: string): void;
    ended(attempt: number, failed: boolean): void;
    retry?(failure: ModelFailure): Promise<ModelRetry | undefined>;
  },
): Promise<NativeAssistantMessage> {
  const { signal, model, sessionId } = request;
  for (let attempt = 1; ; attempt++) {
    let message: NativeAssistantMessage | undefined;
    let streamed = false,
      partial = '';
    try {
      signal.throwIfAborted();
      for await (const event of llm.stream(request)) {
        signal.throwIfAborted();
        if (event.type === 'done') message = event.message;
        else {
          streamed = true;
          if (event.type === 'text-delta') {
            partial += event.text;
            options.delta(event.text);
          }
        }
      }
      if (!message) throw new Error('The model stream ended without a final message');
    } catch (error) {
      message = failedMessage(request, error, partial);
    }
    const failed =
      !!message.errorMessage || message.stopReason === 'error' || message.stopReason === 'aborted';
    options.ended(attempt, failed);
    if (
      !failed ||
      streamed ||
      message.content.length ||
      signal.aborted ||
      message.stopReason === 'aborted' ||
      attempt >= 3
    )
      return message;
    try {
      if (!sessionId) return message; // A plugin retry requires an owned conversation.
      const retry = await options.retry?.({
        sessionId,
        model,
        attempt,
        signal,
        error: message.errorMessage || 'Model request failed',
      });
      if (!retry) return message;
      if (retry.delayMs) await sleep(retry.delayMs, undefined, { signal });
    } catch (error) {
      return failedMessage(request, error);
    }
  }
}
