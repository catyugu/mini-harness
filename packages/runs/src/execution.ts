import type { Attachment } from '@mini-harness/input/message';
import { Service } from 'mini-harness/cordis';
import { sessionVisible } from '@mini-harness/plugin-api/instance';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export interface ExecutionInput {
  message: string;
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel | null;
  attachments?: Attachment[];
}

export interface ExecutionHandle {
  readonly id: string;
  readonly result: Promise<string>;
  /** Cancel only this execution, never a later run or another owner's work. */
  cancel(): boolean;
}

export interface Execution {
  /** The run starts through normal admission. A scheduler can supply a cancellation-aware slot lease. */
  submit(id: string, input: ExecutionInput, options?: {
    signal?: AbortSignal;
    acquire?: (signal: AbortSignal) => Promise<() => void>;
  }): ExecutionHandle;
  status(id: string): RunInfo | undefined;
}

declare module 'mini-harness/cordis' {
  interface Context { harnessExecution: Execution }
}

export function sessionExecution(
  launch: (id: string, input: ExecutionInput, signal: AbortSignal, acquire?: (signal: AbortSignal) => Promise<() => void>) => ExecutionHandle,
  info: (id: string) => RunInfo | undefined
): Execution {
  return Service.track({
    submit(id, input, options = {}) {
      const ctx = Service.caller(this);
      const lifetime = ctx.fiber.signal;
      lifetime.throwIfAborted();
      if (!sessionVisible(ctx, id)) throw new Error('Conversation outside plugin scope');
      const signal = options.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
      signal.throwIfAborted();
      const handle = launch(id, input, signal, options.acquire);
      void ctx.fiber.run(() => handle.result, signal).catch(() => {});
      return handle;
    },
    status(id) {
      const ctx = Service.caller(this);
      ctx.fiber.signal.throwIfAborted();
      if (!sessionVisible(ctx, id)) throw new Error('Conversation outside plugin scope');
      return info(id);
    }
  });
}

declare module '@mini-harness/plugin-api/observations' {
  interface CapabilityObservations {
    'run-started': { type: 'run-started'; sessionId: string; run: RunInfo };
    'run-ended': { type: 'run-ended'; sessionId: string; run: RunInfo };
  }
}
