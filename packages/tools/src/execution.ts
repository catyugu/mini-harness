import type { Context } from 'mini-harness/cordis';
import { toolResultState, type ToolDefinition, type ToolInvocation, type ToolUpdate } from './api.ts';
import { runBatch } from './batch.ts';
import { invokeTool, prepareTool } from './invocation.ts';
export { runTool, toolAvailable } from './invocation.ts';
import type {
  LlmRequest,
  ModelRequestContent,
  NativeAssistantMessage,
  NativeToolMessage,
  ToolCallPart,
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
  start?(call: ToolCallPart): { outcome: 'skipped' | 'denied'; reason: string } | undefined;
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
      const prepared = prepareCall(call, tools.get(call.name), execution);
      yield {
        parallel: prepared.parallel,
        async run(batchSignal: AbortSignal) {
          const rejection = execution.start?.(call);
          const result = rejection
            ? toolFailure(call, rejection.reason, rejection.outcome)
            : batchSignal.aborted
              ? toolFailure(call, batchSignal.reason instanceof Error ? batchSignal.reason.message : String(batchSignal.reason), 'skipped')
              : await prepared.invoke(batchSignal);
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
  outcome?: NativeToolMessage['outcome'],
): NativeToolMessage => ({
  role: 'toolResult',
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: 'text', text: reason }],
  isError: true,
  outcome,
  timestamp: Date.now(),
});

function prepareCall(
  call: ToolCallPart,
  tool: ToolDefinition | undefined,
  execution: ToolExecution,
) {
  try {
    if (call.argumentsError) throw new Error('Invalid arguments for ' + call.name + ': ' + call.argumentsError);
    if (!tool) throw new Error('Tool is no longer available: ' + call.name);
    const prepared = prepareTool(tool, call.arguments);
    let parallel = false;
    try {
      parallel = tool.isConcurrencySafe?.(prepared.args) ?? false;
    } catch {
      // A scheduling hint that fails leaves the call serial.
    }
    return { parallel, invoke: (signal: AbortSignal) => executeTool(call, prepared, execution, signal) };
  } catch (error) {
    return {
      parallel: false,
      invoke: () => toolFailure(call, error instanceof Error ? error.message : String(error)),
    };
  }
}

async function executeTool(
  call: ToolCallPart,
  prepared: ReturnType<typeof prepareTool>,
  execution: ToolExecution,
  signal: AbortSignal,
): Promise<NativeToolMessage> {
  const start = performance.now();
  try {
    const result = await invokeTool(prepared, call.id, {
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
      isError: toolResultState(result) !== 'finished',
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
        cancelled ? 'cancelled' : undefined,
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
