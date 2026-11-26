import type { Context } from 'mini-harness/cordis';
import { type ToolDefinition, type ToolInvocation, type ToolResult, type ToolUpdate } from './api.ts';
import type { TaskContext, TaskHandle, TaskPort } from '@mini-harness/tasks/api';
import { invokeTool, prepareTool } from './invocation.ts';
export { startTool, toolAvailable } from './invocation.ts';
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
  readonly tasks: TaskPort;
  readonly parentTask?: TaskContext;
  readonly resourceId?: string;
  /** Optional consumer policy: accept the call now and retain its independent task for later. */
  background?(call: ToolCallPart): (ToolInvocation & { owner: string }) | undefined;
  /** Decides whether to start the call. A rejection still produces a model-visible result. */
  start?(call: ToolCallPart): { outcome: 'skipped' | 'denied'; reason: string } | undefined;
  update?(call: ToolCallPart, result: ToolUpdate): void;
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
            ? toolFailure(call, rejection.reason, rejection.outcome)
            : await executeTool(call, tool, prepared, execution, batchSignal, invalid);
          await execution.deliver(result, batchSignal);
        },
      };
    }
  }
  await execution.tasks.batch(jobs(), { signal, limit: parallelLimit });
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
  let task: TaskHandle<ToolResult> | undefined;
  try {
    if (!tool) throw new Error('Tool is no longer available: ' + call.name);
    if (invalid) throw new Error(invalid);
    const background = execution.background?.(call);
    task = invokeTool(
      execution.tasks,
      background?.context ? prepareTool(tool, call.arguments, background.context) : prepared!,
      call.id,
      background
        ? {
            ...background,
            parentTask: undefined,
            metadata: {
              ...background.metadata,
              ...(execution.parentTask && { creator: execution.parentTask.id }),
            },
            resourceId: background.resourceId ?? execution.resourceId,
            retain: true,
          }
        : {
            signal,
            parentTask: execution.parentTask,
            resourceId: execution.resourceId,
            onUpdate: (update) => execution.update?.(call, update),
          },
    );
    if (background) {
      const accepted = { taskId: task.id, state: 'queued' };
      return {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: JSON.stringify(accepted) }],
        details: accepted,
        isError: false,
        timestamp: Date.now(),
        elapsedMs: performance.now() - start,
      };
    }
    const result = await task.result;
    return {
      ...result,
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      isError: result.outcome ? true : (result.isError ?? false),
      timestamp: Date.now(),
      elapsedMs: result.elapsedMs ?? performance.now() - start,
    };
  } catch (error) {
    const cancelled = task ? task.state === 'cancelled' || task.state === 'interrupted' : signal.aborted;
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
