import { Check } from 'typebox/value';
import type { ToolCallPart, NativeToolMessage } from '../contracts/llm.js';
import type { ToolDefinition, ToolResult } from '../contracts/tools.js';

/** Arguments, execution, errors and outputs pass through one native tool boundary. */
export async function executeTool(call: ToolCallPart, tool: ToolDefinition | undefined, options: {
  sessionId: string; cwd: string; signal: AbortSignal; update(result: ToolResult): void
}): Promise<NativeToolMessage> {
  const start = performance.now();
  try {
    options.signal.throwIfAborted();
    if (!tool) throw new Error('Tool is no longer available: ' + call.name);
    if (call.argumentsError) throw new Error('Invalid tool arguments: ' + call.argumentsError);
    if (!Check(tool.parameters, call.arguments)) throw new Error('Invalid arguments for tool: ' + call.name);
    const result = await tool.execute(call.id, structuredClone(call.arguments), options.signal, options.update,
      { sessionId: options.sessionId, cwd: options.cwd });
    if (!result || !Array.isArray(result.content) || result.content.some((part) =>
      part?.type !== 'text' && part?.type !== 'image')) throw new Error('Invalid result from tool: ' + call.name);
    // JSON serialization rejects cycles and non-durable values before the caller acknowledges completion.
    const stored: ToolResult = JSON.parse(JSON.stringify(result));
    return { role: 'toolResult', toolCallId: call.id, toolName: call.name, ...stored,
      isError: false, timestamp: Date.now(), elapsedMs: performance.now() - start };
  } catch (error) {
    return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true, timestamp: Date.now(), elapsedMs: performance.now() - start };
  }
}
