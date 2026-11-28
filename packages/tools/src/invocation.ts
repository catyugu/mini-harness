import { isTextImageContent, toolResultStates } from '@mini-harness/llm/api';
import { Check } from 'typebox/value';
import { type ResolvedTool, type ToolInvocation, type ToolResult } from './api.ts';

export function toolAvailable(tool: ResolvedTool) {
  return tool.binding.available();
}

export function prepareTool(tool: ResolvedTool, args: Record<string, unknown>) {
  if (!toolAvailable(tool)) throw new Error('Tool is no longer available: ' + tool.name);
  if (!Check(tool.parameters, args))
    throw new Error('Invalid arguments for ' + tool.name + ': Schema mismatch');
  return { tool, binding: tool.binding, args };
}

/** Execute validated work in an already admitted provider Fiber. */
export async function executePreparedTool(
  { tool, binding, args }: ReturnType<typeof prepareTool>,
  callId: string,
  options: ToolInvocation & { signal: AbortSignal },
): Promise<ToolResult> {
  const { signal, executionId, report, onUpdate, write, waitFor } = options;
  signal.throwIfAborted();
  if (!binding.available()) throw new Error('Tool is no longer available: ' + tool.name);
  const result = await tool.execute(args, {
    callId,
    executionId,
    signal,
    waitFor: waitFor && ((id) => waitFor(id, signal)),
    report,
    update: onUpdate ?? (() => {}),
    write: write ?? (() => {}),
  });
  if (!result || !toolResultStates.includes(result.state) || !isTextImageContent(result.content))
    throw new Error('Invalid result from tool: ' + tool.name);
  return result;
}

export function invokeTool(
  prepared: ReturnType<typeof prepareTool>,
  callId: string,
  options: ToolInvocation = {},
): Promise<ToolResult> {
  const { binding } = prepared;
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
  tool: ResolvedTool,
  callId: string,
  args: Record<string, unknown>,
  options: ToolInvocation = {},
) {
  return invokeTool(prepareTool(tool, args), callId, options);
}
