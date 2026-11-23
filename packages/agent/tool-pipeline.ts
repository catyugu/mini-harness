import { Check } from 'typebox/value';
import type { ToolCallPart, NativeToolMessage } from '../contracts/llm.js';
import { isToolContent, type ToolDefinition, type ToolResult } from '../contracts/tools.js';

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
  run: (call: ToolCallPart, tool?: ToolDefinition) => Promise<void>) {
  let parallel: Promise<void>[] = [];
  const drain = async () => {
    const settled = await Promise.allSettled(parallel);
    parallel = [];
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  };
  for (const call of calls) {
    const tool = tools.get(call.name);
    if (safeToRunTogether(call, tool)) {
      parallel.push(run(call, tool));
      if (parallel.length === parallelLimit) await drain();
    } else {
      if (parallel.length) await drain();
      await run(call, tool);
    }
  }
  if (parallel.length) await drain();
}

/** Arguments, execution, errors and outputs pass through one native tool boundary. */
export async function executeTool(call: ToolCallPart, tool: ToolDefinition | undefined, options: {
  sessionId: string; cwd: string; signal: AbortSignal; update(result: ToolResult): void;
  transform?(content: ToolResult['content']): Promise<ToolResult['content']> | undefined;
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
    if (!options.signal.aborted) {
      try {
        const transformed = await options.transform?.(stored.content);
        if (isToolContent(transformed)) stored.content = JSON.parse(JSON.stringify(transformed));
      } catch {
        // A failed or cancelled transform must not erase an already completed side effect.
      }
    }
    return { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: stored.content, details: stored.details,
      isError: false, timestamp: Date.now(), elapsedMs: performance.now() - start };
  } catch (error) {
    return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true, timestamp: Date.now(), elapsedMs: performance.now() - start };
  }
}
