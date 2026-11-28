import { setTimeout as sleep } from 'node:timers/promises';
import { ModelStreamError, validateNativeMessage } from '@mini-harness/llm/api';
import type {
  LlmPort,
  LlmRequest,
  ModelAttemptMetrics,
  ModelErrorKind,
  NativeAssistantMessage,
} from '@mini-harness/llm/api';
import type { ModelFailure, ModelRetry } from './api.ts';

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
    errorKind: signal.aborted ? undefined : errorKind,
  };
}

export async function requestModel(
  llm: Pick<LlmPort, 'stream'>,
  request: LlmRequest,
  options: {
    request?(request: LlmRequest): void;
    recover?(request: LlmRequest, failure: ModelFailure): Promise<LlmRequest | undefined>;
    delta?(text: string): void;
    thinking?(text: string): void;
    attempt?(metrics: ModelAttemptMetrics): void;
    retry?(failure: ModelFailure): ModelRetry | undefined | Promise<ModelRetry | undefined>;
  },
): Promise<NativeAssistantMessage> {
  const { signal } = request;
  options.request?.(request);
  for (let attempt = 1; ; attempt++) {
    const { model } = request;
    const started = performance.now();
    let firstTokenMs: number | undefined;
    let message: NativeAssistantMessage | undefined;
    let streamed = false,
      partial = '',
      thinking = '';
    try {
      signal.throwIfAborted();
      await llm.stream(request, (event) => {
        if (event.type === 'done') message = event.message;
        else {
          signal.throwIfAborted();
          streamed = true;
          firstTokenMs ??= performance.now() - started;
          if (event.type === 'text-delta') {
            partial += event.text;
            options.delta?.(event.text);
          } else if (event.type === 'thinking-delta') {
            thinking += event.text;
            options.thinking?.(event.text);
          }
        }
      });
      if (!message) throw new Error('The model stream ended without a final message');
      validateNativeMessage(message);
    } catch (error) {
      message = {
        ...failedMessage(request, error, partial, error instanceof ModelStreamError ? error.kind : undefined),
        ...(thinking && {
          content: [
            { type: 'thinking' as const, thinking },
            ...(partial ? [{ type: 'text' as const, text: partial }] : []),
          ],
        }),
        usage: message?.usage,
      };
    }
    options.attempt?.({ elapsedMs: performance.now() - started, firstTokenMs, usage: message.usage });
    if (message.stopReason !== 'error' || streamed || message.content.length || signal.aborted)
      return message;
    if (attempt >= 3) return message;
    const failure: ModelFailure = {
      model,
      attempt,
      signal,
      error: message.errorMessage || 'Model request failed',
      kind: message.errorKind,
    };
    if (failure.kind && failure.kind !== 'transient') {
      const next = await options.recover?.(request, failure);
      if (!next) return message;
      request = next;
      options.request?.(request);
      continue;
    }
    try {
      const custom = await options.retry?.(failure);
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
