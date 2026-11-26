import { Check } from 'typebox/value';
import type { Context } from 'mini-harness/cordis';
import type { TaskData, TaskPort } from '@mini-harness/tasks/api';
import {
  isToolContent,
  type RegisteredTool,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from './api.ts';

interface Invocation extends ToolInvocation {
  provider?: Context;
  registration?: string;
}

/** The actual call is a single task, whether the caller waits or retains it for later. */
export function invokeTool(
  tasks: TaskPort,
  tool: ToolDefinition,
  callId: string,
  args: Record<string, unknown>,
  options: Invocation = {},
) {
  if (!Check(tool.parameters, args))
    throw new Error('Invalid arguments for ' + tool.name + ': Schema mismatch');
  const {
    owner,
    creator,
    signal,
    retain = false,
    provider,
    registration,
    resourceId,
    ownerTask,
    projectResult,
    onUpdate,
  } = options;
  return tasks.start<ToolResult>(
    {
      owner:
        owner ??
        (ownerTask ? 'task:' + ownerTask.id : resourceId ? 'session:' + resourceId : 'tool:' + tool.name),
      creator: creator ?? ownerTask?.id,
      resourceId,
      name: tool.label ?? tool.name,
      type: 'tool-call',
      metadata: { callId, tool: tool.name, ...(registration ? { registration } : {}) },
      provider,
      signal,
      retain,
      projectResult:
        projectResult ??
        (retain
          ? (tool.projectResult ?? ((result) => JSON.parse(JSON.stringify(result)) as TaskData))
          : undefined),
    },
    async (task) => {
      const result = await tool.execute(
        callId,
        args,
        task.signal,
        (update) => {
          task.update(JSON.parse(JSON.stringify(update)) as TaskData);
          onUpdate?.(update);
        },
        { task, owner: ownerTask },
      );
      if (!result || !isToolContent(result.content))
        throw new Error('Invalid result from tool: ' + tool.name);
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
  return 'start' in tool && typeof tool.start === 'function'
    ? (tool as RegisteredTool).start(callId, args, options)
    : invokeTool(tasks, tool, callId, args, { ...options, provider: options.context });
}
