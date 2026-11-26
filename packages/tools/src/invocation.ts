import { Check } from 'typebox/value';
import type { Context } from 'mini-harness/cordis';
import type { TaskData, TaskPort } from '@mini-harness/tasks/api';
import { isToolContent, type ToolDefinition, type ToolInvocation, type ToolResult } from './api.ts';

const bindingKey = Symbol('tool binding');

interface Binding {
  provider?: Context;
  registration: string;
  resourceId?: string;
  available(): boolean;
  resolve(context: Context): ToolDefinition;
}

type BoundTool = ToolDefinition & { [bindingKey]?: Binding };

export function bindTool(tool: ToolDefinition, binding: Binding): ToolDefinition {
  return { ...tool, [bindingKey]: binding } as BoundTool;
}

export function toolAvailable(tool: ToolDefinition) {
  return (tool as BoundTool)[bindingKey]?.available() ?? true;
}

export function prepareTool(tool: ToolDefinition, args: Record<string, unknown>, context?: Context) {
  const binding = (tool as BoundTool)[bindingKey];
  const definition = context && binding ? binding.resolve(context) : tool;
  if (!Check(definition.parameters, args))
    throw new Error('Invalid arguments for ' + definition.name + ': Schema mismatch');
  return { tool: definition, binding, args };
}

/** The single invocation boundary for registered and standalone tools. */
export function invokeTool(
  tasks: TaskPort,
  { tool, binding, args }: ReturnType<typeof prepareTool>,
  callId: string,
  options: ToolInvocation = {},
) {
  const assertAvailable = () => {
    if (binding && !binding.available()) throw new Error('Tool is no longer available: ' + tool.name);
  };
  assertAvailable();
  const { owner, signal, retain = false, ownerTask, onUpdate, context, metadata } = options;
  const resourceId = binding?.resourceId ?? options.resourceId;
  return tasks.start<ToolResult>(
    {
      owner: owner ?? ownerTask?.owner ?? (resourceId ? 'session:' + resourceId : 'tool:' + tool.name),
      parentId: ownerTask?.id,
      name: tool.label ?? tool.name,
      type: 'tool-call',
      metadata: {
        ...metadata,
        callId,
        tool: tool.name,
        ...(ownerTask && { creator: ownerTask.id }),
        ...(binding && { registration: binding.registration }),
        ...(resourceId && { resourceId }),
      },
      provider: binding?.provider ?? context,
      signal,
      retain,
    },
    async (task) => {
      assertAvailable();
      const result = await tool.execute(args, {
        callId,
        task,
        signal: task.signal,
        owner: ownerTask,
        update(update) {
          task.update(JSON.parse(JSON.stringify(update)) as TaskData);
          onUpdate?.(update);
        },
      });
      if (!result || !isToolContent(result.content))
        throw new Error('Invalid result from tool: ' + tool.name);
      if (retain)
        task.setResult(tool.projectResult?.(result) ?? (JSON.parse(JSON.stringify(result)) as TaskData));
      return result;
    },
  );
}

export function startTool(
  tasks: TaskPort,
  tool: ToolDefinition,
  callId: string,
  args: Record<string, unknown>,
  options: ToolInvocation = {},
) {
  return invokeTool(tasks, prepareTool(tool, args, options.context), callId, options);
}
