import { Check } from 'typebox/value';
import type { ToolCallPart, NativeToolMessage } from '#mini-harness/contracts/llm.js';
import { isToolContent, type ToolDefinition, type ToolResult } from '#mini-harness/contracts/tools.js';

const parallelLimit = 16;

function safeToRunTogether(call: ToolCallPart, tool?: ToolDefinition) {
  if (!tool?.isConcurrencySafe || call.argumentsError) return false;
  try {
    return Check(tool.parameters, call.arguments) && tool.isConcurrencySafe(structuredClone(call.arguments)) === true;
  } catch {
    return false;
  }
}

/** A serial call is a barrier. Each running call can persist its own result immediately. */
export async function scheduleTools(calls: ToolCallPart[], tools: ReadonlyMap<string, ToolDefinition>,
  signal: AbortSignal, run: (call: ToolCallPart, tool: ToolDefinition | undefined, signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const batchSignal = AbortSignal.any([signal, controller.signal]);
  const active = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const start = (call: ToolCallPart, tool: ToolDefinition | undefined) => {
    const task = Promise.resolve().then(() => run(call, tool, batchSignal)).catch((error) => {
      if (!failure) {
        failure = { error };
        controller.abort(error);
      }
    }).finally(() => active.delete(task));
    active.add(task);
    return task;
  };
  for (const call of calls) {
    if (failure) break;
    const tool = tools.get(call.name);
    if (safeToRunTogether(call, tool)) {
      start(call, tool);
      if (active.size === parallelLimit) await Promise.race(active);
    } else {
      await Promise.all(active);
      if (failure) break;
      await start(call, tool);
    }
  }
  await Promise.all(active);
  if (failure) throw failure.error;
}

/** Arguments, execution, errors and outputs pass through one native tool boundary. */
export async function executeTool(call: ToolCallPart, tool: ToolDefinition | undefined, options: {
  sessionId: string; cwd: string; signal: AbortSignal; update(result: ToolResult): void;
}): Promise<NativeToolMessage> {
  const start = performance.now();
  try {
    options.signal.throwIfAborted();
    if (!tool) throw new Error('Tool is no longer available: ' + call.name);
    if (call.argumentsError) throw new Error('Invalid tool arguments: ' + call.argumentsError);
    if (!Check(tool.parameters, call.arguments)) throw new Error('Invalid arguments for tool: ' + call.name);
    const result = await tool.execute(call.id, structuredClone(call.arguments), options.signal, options.update,
      { sessionId: options.sessionId, cwd: options.cwd });
    if (!result || !isToolContent(result.content)) throw new Error('Invalid result from tool: ' + call.name);
    // JSON serialization rejects cycles and non-durable values before the caller acknowledges completion.
    const stored: ToolResult = JSON.parse(JSON.stringify(result));
    return { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: stored.content, details: stored.details,
      isError: false, timestamp: Date.now(), elapsedMs: performance.now() - start };
  } catch (error) {
    return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true, timestamp: Date.now(), elapsedMs: performance.now() - start };
  }
}
