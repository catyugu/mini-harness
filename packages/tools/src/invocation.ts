import { isTextImageContent, toolResultStates } from '@mini-harness/llm/api';
import { Check } from 'typebox/value';
import type { Context } from 'mini-harness/cordis';
import { type ToolDefinition, type ToolInvocation, type ToolResult } from './api.ts';

const bindingKey = Symbol('tool binding');

interface Binding {
  provider: Context;
  signal: AbortSignal;
  available(): boolean;
}

type BoundTool = ToolDefinition & { [bindingKey]?: Binding };

export function bindTool(tool: ToolDefinition, binding: Binding): ToolDefinition {
  return { ...tool, [bindingKey]: binding } as BoundTool;
}

export function toolAvailable(tool: ToolDefinition) {
  return (tool as BoundTool)[bindingKey]?.available() ?? true;
}

export function prepareTool(tool: ToolDefinition, args: Record<string, unknown>) {
  const binding = (tool as BoundTool)[bindingKey];
  if (!toolAvailable(tool)) throw new Error('Tool is no longer available: ' + tool.name);
  if (!Check(tool.parameters, args))
    throw new Error('Invalid arguments for ' + tool.name + ': Schema mismatch');
  return { tool, binding, args };
}

/** Execute validated work in an already admitted provider Fiber. */
export async function executePreparedTool(
  { tool, binding, args }: ReturnType<typeof prepareTool>,
  callId: string,
  options: ToolInvocation & { signal: AbortSignal },
): Promise<ToolResult> {
  const { signal, executionId, report, onUpdate, write, waitFor } = options;
  signal.throwIfAborted();
  if (binding && !binding.available()) throw new Error('Tool is no longer available: ' + tool.name);
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
  if (!binding)
    return executePreparedTool(prepared, callId, {
      ...options,
      signal: options.signal ?? AbortSignal.any([]),
    });
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
