import type { Attachment } from '@mini-harness/input/message';
import { extension } from '@mini-harness/kernel/contributions';
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
}

export const launchExecution = Symbol.for('mini-harness.launchExecution');

export interface ExecutionPort {
  [launchExecution](id: string, input: ExecutionInput, signal: AbortSignal,
    acquire?: (signal: AbortSignal) => Promise<() => void>): ExecutionHandle;
  info(id: string): RunInfo | undefined;
  cancel(id: string): boolean;
}

declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessExecution: ExecutionPort }
}

export const executionExtensions = {
  control: extension((source) => {
    const execution = source.service('harnessExecution');
    const check = (id: string) => {
      source.signal.throwIfAborted();
      if (!source.visible(id)) throw new Error('Conversation outside plugin scope');
    };
    return {
      submit(id: string, input: ExecutionInput, options: {
        signal?: AbortSignal;
        acquire?: (signal: AbortSignal) => Promise<() => void>;
      } = {}): ExecutionHandle {
        check(id);
        const signal = options.signal ? AbortSignal.any([source.signal, options.signal]) : source.signal;
        signal.throwIfAborted();
        const handle = execution[launchExecution](id, input, signal, options.acquire);
        void source.run('execute conversation', () => handle.result, options.signal).catch(() => {});
        return handle;
      },
      status(id: string) { check(id); return execution.info(id); },
      cancel(id: string, runId: string) {
        check(id);
        return execution.info(id)?.id === runId && execution.cancel(id);
      }
    };
  })
};

export type Execution = ReturnType<(typeof executionExtensions.control)[keyof typeof executionExtensions.control]>;
