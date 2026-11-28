import type { Context } from 'mini-harness/cordis';
import { type ToolDefinition, type ToolInvocation, type ToolUpdate } from './api.ts';
import { runBatch } from './batch.ts';
import { invokeTool, prepareTool } from './invocation.ts';
export { runTool, toolAvailable } from './invocation.ts';
import type {
  LlmRequest,
  ModelRequestContent,
  NativeAssistantMessage,
  NativeToolMessage,
  ToolCallPart,
  ToolResultState,
} from '@mini-harness/llm/api';
import type { ToolSchema } from '@mini-harness/llm/vocabulary';

export interface ToolTurn {
  readonly model: LlmRequest['model'];
  readonly turn: number;
  readonly signal: AbortSignal;
}

export interface ToolExecution {
  readonly signal: AbortSignal;
  readonly executionId?: string;
  waitFor?: ToolInvocation['waitFor'];
  /** Decides whether to start the call. A rejection still produces a model-visible result. */
  start?(call: ToolCallPart): { state: 'skipped' | 'denied'; reason: string } | undefined;
  update?(call: ToolCallPart, result: ToolUpdate): void;
  write?(call: ToolCallPart, text: string, channel: string): void;
  deliver(result: NativeToolMessage, signal: AbortSignal): Promise<void>;
}

export interface ToolExecutorPort {
  present(
    content: ModelRequestContent,
    tools: readonly ToolSchema[],
    context: ToolTurn,
  ): ModelRequestContent & { tools?: ToolSchema[] };
  interpret(message: NativeAssistantMessage, context: ToolTurn): NativeAssistantMessage;
  /** Interpret, execute and deliver a result for each call. */
  execute(
    calls: readonly ToolCallPart[],
    tools: ReadonlyMap<string, ToolDefinition>,
    execution: ToolExecution,
  ): Promise<void>;
}

const parallelLimit = 16;

export const executeTools: ToolExecutorPort['execute'] = async (calls, tools, execution) => {
  const { signal } = execution;
  function* jobs() {
    for (const call of calls) {
      const tool = tools.get(call.name);
      let invalid = call.argumentsError && 'Invalid arguments for ' + call.name + ': ' + call.argumentsError;
      let prepared: ReturnType<typeof prepareTool> | undefined;
      if (!invalid && tool) {
        try {
          prepared = prepareTool(tool, call.arguments);
        } catch (error) {
          invalid = error instanceof Error ? error.message : String(error);
        }
      }
      let parallel = false;
      if (!invalid && tool?.isConcurrencySafe) {
        try {
          parallel = tool.isConcurrencySafe(call.arguments);
        } catch {
          // A scheduling hint that fails leaves the call serial.
        }
      }
      yield {
        parallel,
        async run(batchSignal: AbortSignal) {
          const rejection = execution.start?.(call);
          const result = rejection
            ? toolFailure(call, rejection.reason, rejection.state)
            : await executeTool(call, tool, prepared, execution, batchSignal, invalid);
          await execution.deliver(result, batchSignal);
        },
      };
    }
  }
  await runBatch(jobs(), { signal, limit: parallelLimit });
};

export const toolFailure = (
  call: ToolCallPart,
  reason: string,
  state: Exclude<ToolResultState, 'finished'> = 'error',
): NativeToolMessage => ({
  role: 'toolResult',
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: 'text', text: reason }],
  state,
  timestamp: Date.now(),
});

async function executeTool(
  call: ToolCallPart,
  tool: ToolDefinition | undefined,
  prepared: ReturnType<typeof prepareTool> | undefined,
  execution: Parameters<ToolExecutorPort['execute']>[2],
  signal: AbortSignal,
  invalid?: string,
): Promise<NativeToolMessage> {
  if (signal.aborted)
    return toolFailure(
      call,
      signal.reason instanceof Error ? signal.reason.message : String(signal.reason),
      'skipped',
    );
  const start = performance.now();
  try {
    if (!tool) throw new Error('Tool is no longer available: ' + call.name);
    if (invalid) throw new Error(invalid);
    const result = await invokeTool(prepared!, call.id, {
      signal,
      executionId: execution.executionId,
      waitFor: execution.waitFor,
      onUpdate: (update) => execution.update?.(call, update),
      write: (text, channel = 'output') => execution.write?.(call, text, channel),
    });
    return {
      ...result,
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      timestamp: Date.now(),
      elapsedMs: result.elapsedMs ?? performance.now() - start,
    };
  } catch (error) {
    const cancelled =
      (signal.aborted && error === signal.reason) || (error instanceof Error && error.name === 'AbortError');
    return {
      ...toolFailure(
        call,
        error instanceof Error ? error.message : String(error),
        cancelled ? 'cancelled' : 'error',
      ),
      elapsedMs: performance.now() - start,
    };
  }
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessToolExecutor: ToolExecutorPort;
  }
}

export const nativeExecutor: ToolExecutorPort = {
  present: (content, tools) => ({ ...content, tools: [...tools] }),
  interpret: (message) => message,
  execute: executeTools,
};

export const executorMetadata = { title: 'Tool Executor' };

export const executor = {
  provide: ['harnessToolExecutor'],
  apply(ctx: Context) {
    ctx.provide('harnessToolExecutor', nativeExecutor);
  },
};
