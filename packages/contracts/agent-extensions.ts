import { extension, orderedHook, type OrderedHook } from './contributions.js';
import type { ModelChoice } from './conversation.js';
import type { InputSource, PreparedMessage } from './input.js';
import type { NativeUserMessage } from './llm.js';
import type { CapabilityObservation } from './events.js';
import type { ModelFailure, ModelRequestTransform, ModelRetry } from './extensions.js';

export interface InputContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: Readonly<ModelChoice>;
  readonly source: InputSource;
  readonly original: Readonly<PreparedMessage>;
  readonly signal: AbortSignal;
}

export type InputPreparation = (content: NativeUserMessage['content'], context: InputContext) =>
  NativeUserMessage['content'] | { reject: string } | undefined |
  Promise<NativeUserMessage['content'] | { reject: string } | undefined>;

export const agentExtensions = {
  prepareInput: extension((source, handler: InputPreparation, order: number = 0) =>
    orderedHook(source, 'input preparation', handler, order, (hook, active) =>
      source.context.on('harness/prepare-input', (id, hooks) => { if (active(id)) hooks.push(hook); }))),
  modelRequest: extension((source, handler: ModelRequestTransform, order: number = 0) =>
    orderedHook(source, 'model request', handler, order, (hook, active) =>
      source.context.on('harness/model-request', (id, hooks) => { if (active(id)) hooks.push(hook); }))),
  retryModel: extension((source, handler: (failure: ModelFailure) => ModelRetry | undefined | Promise<ModelRetry | undefined>) =>
    source.context.on('harness/model-retry', async ({ signal, ...failure }) => {
      if (!source.visible(failure.sessionId)) return;
      return source.run('model retry', async (signal) => {
        const retry = await handler({ ...structuredClone(failure), signal });
        if (retry !== undefined && (!retry || typeof retry !== 'object' ||
            (retry.delayMs !== undefined && (!Number.isFinite(retry.delayMs) || retry.delayMs < 0 || retry.delayMs > 30000))))
          throw new Error('Invalid model retry decision');
        return retry === undefined ? undefined : { delayMs: retry.delayMs };
      }, signal);
    })),
  observe: extension((source, handler: (event: CapabilityObservation, signal: AbortSignal) => void | Promise<void>) =>
    source.context.on('harness/observe', (event) => {
      const scoped = event.type === 'session-deleted'
        ? !source.scopeKey || event.scopeKeys.includes(source.scopeKey)
        : source.visible(event.sessionId);
      if (!scoped || source.signal.aborted) return;
      void source.run('observation ' + event.type, (signal) => handler(structuredClone(event), signal)).catch((error: unknown) => {
        if (!source.signal.aborted) source.context.logger.warn(String(error));
      });
    }))
};

declare module 'cordis' {
  interface Events {
    'harness/prepare-input'(sessionId: string, handlers: OrderedHook<InputPreparation>[]): void;
    'harness/model-request'(sessionId: string, handlers: OrderedHook<ModelRequestTransform>[]): void;
    'harness/model-retry'(failure: ModelFailure): ModelRetry | undefined | Promise<ModelRetry | undefined>;
  }
}
