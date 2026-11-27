import { Check } from 'typebox/value';
import {
  isToolContent,
  toolBinding,
  type ResolvedTool,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from './api.ts';

function isResolved(tool: ToolDefinition): tool is ResolvedTool {
  return toolBinding in tool;
}

export function toolAvailable(tool: ToolDefinition) {
  return !isResolved(tool) || tool[toolBinding].available();
}

export function prepareTool<T extends ToolDefinition>(tool: T, args: Record<string, unknown>) {
  if (!toolAvailable(tool)) throw new Error('Tool is no longer available: ' + tool.name);
  if (!Check(tool.parameters, args))
    throw new Error('Invalid arguments for ' + tool.name + ': Schema mismatch');
  return { tool, args };
}

/** Execute validated work in an already admitted provider Fiber. */
export async function executePreparedTool(
  { tool, args }: ReturnType<typeof prepareTool>,
  callId: string,
  options: ToolInvocation & { signal: AbortSignal },
): Promise<ToolResult> {
  const { signal, executionId, report, onUpdate, write, waitFor } = options;
  signal.throwIfAborted();
  if (!toolAvailable(tool)) throw new Error('Tool is no longer available: ' + tool.name);
  const result = await tool.execute(args, {
    callId,
    executionId,
    signal,
    waitFor: waitFor && ((id) => waitFor(id, signal)),
    report,
    update: onUpdate ?? (() => {}),
    write: write ?? (() => {}),
  });
  if (!result || !isToolContent(result.content)) throw new Error('Invalid result from tool: ' + tool.name);
  return result;
}

export function invokeTool(
  prepared: ReturnType<typeof prepareTool>,
  callId: string,
  options: ToolInvocation = {},
): Promise<ToolResult> {
  const { tool } = prepared;
  if (!isResolved(tool))
    return executePreparedTool(prepared, callId, {
      ...options,
      signal: options.signal ?? AbortSignal.any([]),
    });
  const binding = tool[toolBinding];
  const signal = options.signal ? AbortSignal.any([binding.signal, options.signal]) : binding.signal;
  // Preserve a tool's observed result when cancellation races its return.
  let completed: ToolResult | undefined;
  return binding.provider.fiber
    .run(async (signal) => {
      completed = await executePreparedTool(prepared, callId, { ...options, signal });
      return completed;
    }, signal)
    .catch((error) => {
      if (completed) return completed;
      throw error;
    });
}

export function runTool(
  tool: ToolDefinition,
  callId: string,
  args: Record<string, unknown>,
  options: ToolInvocation = {},
) {
  return invokeTool(prepareTool(tool, args), callId, options);
}
