import { Check } from 'typebox/value';
import type { Context } from 'mini-harness/cordis';
import { isToolContent, type ToolDefinition, type ToolInvocation, type ToolResult } from './api.ts';

const bindingKey = Symbol('tool binding');

interface Binding {
  provider?: Context;
  signal: AbortSignal;
  available(): boolean;
  track(work: Promise<unknown>): void;
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

/** Hold a registration from acceptance through settlement, including queued work. */
export function withToolLease<T>(
  { tool, binding }: ReturnType<typeof prepareTool>,
  start: (signal: AbortSignal | undefined, provider: Context | undefined) => Promise<T>,
) {
  if (binding && !binding.available()) throw new Error('Tool is no longer available: ' + tool.name);
  if (!binding) return start(undefined, undefined);
  let settle!: () => void;
  binding.track(
    new Promise<void>((resolve) => {
      settle = resolve;
    }),
  );
  try {
    const work = start(binding.signal, binding.provider);
    void work.then(settle, settle);
    return work;
  } catch (error) {
    settle();
    throw error;
  }
}

export function invokeTool(
  prepared: ReturnType<typeof prepareTool>,
  callId: string,
  options: ToolInvocation = {},
): Promise<ToolResult> {
  const { tool, args } = prepared;
  return withToolLease(prepared, (lifetime, provider) => {
    const signal = AbortSignal.any([lifetime, options.signal].filter((value) => value !== undefined));
    let completed: { result: ToolResult } | undefined;
    const execute = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (prepared.binding && !prepared.binding.available())
        throw new Error('Tool is no longer available: ' + tool.name);
      const result = await tool.execute(args, {
        callId,
        executionId: options.executionId,
        signal,
        waitFor: options.waitFor && ((id) => options.waitFor!(id, signal)),
        report: options.report,
        update: options.onUpdate ?? (() => {}),
        write: options.write ?? (() => {}),
      });
      if (!result || !isToolContent(result.content))
        throw new Error('Invalid result from tool: ' + tool.name);
      completed = { result };
      return result;
    };
    // Preserve an observed result if the provider fiber sees a concurrent abort on exit.
    return provider
      ? provider.fiber.run(execute, signal).catch((error) => {
          if (completed) return completed.result;
          throw error;
        })
      : execute(signal);
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
