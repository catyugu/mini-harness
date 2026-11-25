import { isToolContent, type ToolDefinition, type ToolUpdate } from './api.ts';
import { Check } from 'typebox/value';
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
  /** Reports a started call and returns the reason to skip it, if any. */
  start?(call: ToolCallPart): string | undefined;
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
  const controller = new AbortController();
  const batchSignal = AbortSignal.any([signal, controller.signal]);
  const active = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const start = (run: () => Promise<NativeToolMessage>) => {
    const task = Promise.resolve()
      .then(run)
      .then((result) => execution.deliver(result, batchSignal))
      .catch((error) => {
        if (!failure) {
          failure = { error };
          controller.abort(error);
        }
      })
      .finally(() => active.delete(task));
    active.add(task);
    return task;
  };
  for (const call of calls) {
    if (failure) break;
    const tool = tools.get(call.name);
    let invalid = call.argumentsError;
    if (!invalid && tool && !Check(tool.parameters, call.arguments)) invalid = 'Schema mismatch';
    let parallel = false;
    if (!invalid && tool?.isConcurrencySafe) {
      try {
        parallel = tool.isConcurrencySafe(call.arguments);
      } catch {
        // A scheduling hint that fails leaves the call serial.
      }
    }
    const run = async () => {
      const skip = execution.start?.(call);
      if (skip) return failedTool(call, skip);
      return executeTool(call, tool, execution, batchSignal, invalid);
    };
    if (parallel) {
      start(run);
      if (active.size === parallelLimit) await Promise.race(active);
    } else {
      await Promise.all(active);
      if (failure) break;
      await start(run);
    }
  }
  await Promise.all(active);
  if (failure) throw failure.error;
};

export const failedTool = (call: ToolCallPart, reason: string): NativeToolMessage => ({
  role: 'toolResult',
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: 'text', text: reason }],
  isError: true,
  timestamp: Date.now(),
});

async function executeTool(
  call: ToolCallPart,
  tool: ToolDefinition | undefined,
  execution: Parameters<ToolExecutorPort['execute']>[2],
  signal: AbortSignal,
  invalid?: string,
): Promise<NativeToolMessage> {
  const start = performance.now();
  try {
    signal.throwIfAborted();
    if (!tool) throw new Error('Tool is no longer available: ' + call.name);
    if (invalid) throw new Error('Invalid arguments for ' + call.name + ': ' + invalid);
    const result = await tool.execute(call.id, call.arguments, signal, (update) =>
      execution.update?.(call, update),
    );
    if (!result || !isToolContent(result.content)) throw new Error('Invalid result from tool: ' + call.name);
    return {
      ...result,
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      isError: result.isError ?? false,
      timestamp: Date.now(),
      elapsedMs: result.elapsedMs ?? performance.now() - start,
    };
  } catch (error) {
    return {
      ...failedTool(call, error instanceof Error ? error.message : String(error)),
      elapsedMs: performance.now() - start,
    };
  }
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessToolExecutor: ToolExecutorPort;
  }
}
