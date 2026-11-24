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
  /** Cancel only this execution, never a later run or another owner's work. */
  cancel(): boolean;
}

export const executionForPlugin = Symbol.for('mini-harness.executionForPlugin');

export interface ExecutionPort {
  [executionForPlugin]: {
    launch(id: string, input: ExecutionInput, signal: AbortSignal,
      acquire?: (signal: AbortSignal) => Promise<() => void>): ExecutionHandle;
    info(id: string): RunInfo | undefined;
  };
}

export interface Execution {
  /** The run starts through normal admission. A scheduler can supply a cancellation-aware slot lease. */
  submit(id: string, input: ExecutionInput, options?: {
    signal?: AbortSignal;
    acquire?: (signal: AbortSignal) => Promise<() => void>;
  }): ExecutionHandle;
  status(id: string): RunInfo | undefined;
}

declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessExecution: ExecutionPort }
}

export const executionExtensions = {
  control: extension((source): Execution => {
    const execution = source.service('harnessExecution')[executionForPlugin];
    const check = (id: string) => {
      source.signal.throwIfAborted();
      if (!source.visible(id)) throw new Error('Conversation outside plugin scope');
    };
    return {
      submit(id, input, options = {}) {
        check(id);
        const signal = options.signal ? AbortSignal.any([source.signal, options.signal]) : source.signal;
        signal.throwIfAborted();
        const handle = execution.launch(id, input, signal, options.acquire);
        void source.run('execute conversation', () => handle.result, options.signal).catch(() => {});
        return handle;
      },
      status(id) { check(id); return execution.info(id); }
    };
  })
};
