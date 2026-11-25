import {
  ToolApprovalDenied,
  isToolContent,
  type ToolDefinition,
  type ToolResult,
} from '@mini-harness/tools/api';
import { Check } from 'typebox/value';
import type { ToolCallPart, NativeToolMessage } from '@mini-harness/llm/api';
import type { ToolDispatch, ToolScheduler } from './api.ts';

const parallelLimit = 16;

function safeToRunTogether(call: ToolCallPart, tool?: ToolDefinition) {
  if (!tool?.isConcurrencySafe || call.argumentsError) return false;
  try {
    return (
      Check(tool.parameters, call.arguments) &&
      tool.isConcurrencySafe(structuredClone(call.arguments)) === true
    );
  } catch {
    return false;
  }
}

/** A serial call is a barrier. Each running call can persist its own result immediately. */
export async function scheduleTools(
  calls: readonly ToolDispatch[],
  signal: AbortSignal,
  run: (id: string, signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  const batchSignal = AbortSignal.any([signal, controller.signal]);
  const active = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const start = (call: ToolDispatch) => {
    const task = Promise.resolve()
      .then(() => run(call.id, batchSignal))
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
    if (call.parallel) {
      start(call);
      if (active.size === parallelLimit) await Promise.race(active);
    } else {
      await Promise.all(active);
      if (failure) break;
      await start(call);
    }
  }
  await Promise.all(active);
  if (failure) throw failure.error;
}

/** A scheduler cannot change an advertised call or substitute its authorized tool lease. */
export async function dispatchTools(
  executor: ToolScheduler,
  calls: ToolCallPart[],
  tools: ReadonlyMap<string, ToolDefinition>,
  signal: AbortSignal,
  run: (call: ToolCallPart, tool: ToolDefinition | undefined, signal: AbortSignal) => Promise<void>,
) {
  const pending = new Map(calls.map((call) => [call.id, call]));
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const active: Promise<void>[] = [];
  let failure: { error: unknown } | undefined;
  try {
    await executor.schedule(
      calls.map((call) => ({
        id: call.id,
        name: call.name,
        parallel: safeToRunTogether(call, tools.get(call.name)),
      })),
      lifetime,
      (id, scheduledSignal) => {
        const call = pending.get(id);
        if (!call) throw new Error('Unknown or already scheduled tool call: ' + id);
        pending.delete(id);
        const task = Promise.resolve().then(() =>
          run(call, tools.get(call.name), AbortSignal.any([lifetime, scheduledSignal])),
        );
        active.push(task);
        void task.catch((error) => {
          failure ??= { error };
          controller.abort(error);
        });
        return task;
      },
    );
    if (pending.size) throw new Error('Tool executor omitted calls: ' + [...pending.keys()].join(', '));
  } catch (error) {
    failure ??= { error };
    controller.abort(error);
  } finally {
    await Promise.allSettled(active);
  }
  if (failure) throw failure.error;
}

/** Arguments, execution, errors and outputs pass through one native tool boundary. */
export async function executeTool(
  call: ToolCallPart,
  tool: ToolDefinition | undefined,
  options: {
    sessionId: string;
    cwd: string;
    signal: AbortSignal;
    phase(state: 'approval' | 'running'): void;
    update(result: ToolResult): void;
  },
): Promise<NativeToolMessage> {
  let start = performance.now();
  let approvalMs: number | undefined;
  let inApproval = false;
  try {
    options.signal.throwIfAborted();
    if (!tool) throw new Error('Tool is no longer available: ' + call.name);
    if (call.argumentsError) throw new Error('Invalid tool arguments: ' + call.argumentsError);
    if (!Check(tool.parameters, call.arguments)) throw new Error('Invalid arguments for tool: ' + call.name);
    const result = await tool.execute(
      call.id,
      structuredClone(call.arguments),
      options.signal,
      options.update,
      {
        sessionId: options.sessionId,
        cwd: options.cwd,
        async waitForApproval(request) {
          inApproval = true;
          const requestedAt = performance.now();
          options.phase('approval');
          try {
            await request();
          } finally {
            approvalMs = performance.now() - requestedAt;
          }
          inApproval = false;
          start = performance.now();
          options.phase('running');
        },
      },
    );
    if (!result || !isToolContent(result.content)) throw new Error('Invalid result from tool: ' + call.name);
    // JSON serialization rejects cycles and non-durable values before the caller acknowledges completion.
    const stored: ToolResult = JSON.parse(JSON.stringify(result));
    return {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: stored.content,
      details: approvalMs === undefined ? stored.details : { ...stored.details, approvalMs },
      isError: false,
      timestamp: Date.now(),
      elapsedMs: performance.now() - start,
    };
  } catch (error) {
    return {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
      timestamp: Date.now(),
      elapsedMs: inApproval ? 0 : performance.now() - start,
      details:
        approvalMs === undefined
          ? undefined
          : {
              approvalMs,
              approvalDenied:
                error instanceof ToolApprovalDenied ||
                (error instanceof Error && error.cause instanceof ToolApprovalDenied),
            },
    };
  }
}
