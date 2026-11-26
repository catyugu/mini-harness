import { setTimeout as sleep } from 'node:timers/promises';
import type {
  LlmPort,
  LlmRequest,
  ModelAttemptMetrics,
  ModelErrorKind,
  NativeAssistantMessage,
} from '@mini-harness/llm/api';
import type { ModelFailure, ModelRetry } from './events.ts';

function failedMessage(
  { model, signal }: LlmRequest,
  error: unknown,
  partial = '',
  errorKind?: ModelErrorKind,
): NativeAssistantMessage {
  return {
    role: 'assistant',
    content: partial ? [{ type: 'text', text: partial }] : [],
    timestamp: Date.now(),
    provider: model.provider,
    model: model.id,
    stopReason: signal.aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    errorKind,
  };
}

export async function requestModel(
  llm: Pick<LlmPort, 'stream'> & Partial<Pick<LlmPort, 'select'>>,
  request: LlmRequest,
  options: {
    delta?(text: string): void;
    attempt?(metrics: ModelAttemptMetrics): void;
    retry?(failure: ModelFailure): ModelRetry | undefined | Promise<ModelRetry | undefined>;
  },
): Promise<NativeAssistantMessage> {
  const { signal, model } = request;
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    let firstTokenMs: number | undefined;
    let message: NativeAssistantMessage | undefined;
    let streamed = false,
      partial = '';
    try {
      signal.throwIfAborted();
      for await (const event of llm.stream(request)) {
        if (event.type === 'done') message = event.message;
        else {
          signal.throwIfAborted();
          streamed = true;
          firstTokenMs ??= performance.now() - started;
          if (event.type === 'text-delta') {
            partial += event.text;
            options.delta?.(event.text);
          }
        }
      }
      if (!message) throw new Error('The model stream ended without a final message');
    } catch (error) {
      message = {
        ...failedMessage(request, error, partial, llm.select?.(model)?.classifyError?.(error)),
        usage: message?.usage,
      };
    }
    options.attempt?.({ elapsedMs: performance.now() - started, firstTokenMs, usage: message.usage });
    const failed =
      !!message.errorMessage || message.stopReason === 'error' || message.stopReason === 'aborted';
    if (!failed || streamed || message.content.length || signal.aborted || message.stopReason === 'aborted')
      return message;
    if (message.errorKind && message.errorKind !== 'transient') return message;
    try {
      const custom = await options.retry?.({
        model,
        attempt,
        signal,
        error: message.errorMessage || 'Model request failed',
        kind: message.errorKind,
      });
      const retry =
        custom ??
        (message.errorKind === 'transient' && attempt < 3
          ? { delayMs: 250 * 2 ** (attempt - 1) }
          : undefined);
      if (!retry) return message;
      if (retry.delayMs !== undefined) {
        if (!Number.isSafeInteger(retry.delayMs) || retry.delayMs < 0 || retry.delayMs > 2_147_483_647)
          throw new Error('Invalid model retry delay');
        if (retry.delayMs) await sleep(retry.delayMs, undefined, { signal });
      }
    } catch (error) {
      return failedMessage(request, error);
    }
  }
}
