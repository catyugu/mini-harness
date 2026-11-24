import { extension, orderHooks, scopedHook, type OrderedHook } from '@mini-harness/kernel/contributions';
import type { Context } from 'cordis';
import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';

export interface ToolProjection {
  sessionId: string;
  tool: string;
  content: MessageContent;
}

export type ToolProjectionHandler = (projection: ToolProjection) => MessageContent | undefined;

export const sessionDisplayExtensions = {
  project: extension((source, handler: ToolProjectionHandler, order: number = 0) =>
    scopedHook<ToolProjectionHandler>(source, 'tool projection', order, (assertActive) => (request) => {
      try {
        assertActive(request.sessionId);
        const result = handler(structuredClone(request));
        if (result === undefined) return;
        if (typeof result !== 'string' && (!Array.isArray(result) ||
            !result.every((block) => block && typeof block.type === 'string')))
          throw new Error('Invalid tool projection');
        return structuredClone(result);
      } catch (error) {
        source.context.logger.warn('Plugin %s tool projection failed: %s', source.instanceId, String(error));
      }
    }, (hook, active) =>
      source.context.on('harness/tool-projection', (id, hooks) => { if (active(id)) hooks.push(hook); })))
};

declare module 'cordis' {
  interface Events {
    'harness/tool-projection'(sessionId: string, handlers: OrderedHook<ToolProjectionHandler>[]): void;
  }
}

export function projectTool(ctx: Context, projection: ToolProjection) {
  const hooks: OrderedHook<ToolProjectionHandler>[] = [];
  ctx.emit('harness/tool-projection', projection.sessionId, hooks);
  let { content } = projection;
  for (const { invoke } of orderHooks(hooks)) content = invoke({ ...projection, content }) ?? content;
  return content;
}

export function projectHistory(ctx: Context, sessionId: string, messages: ViewMessage[]) {
  return messages.map((message) => message.role === 'toolResult' && message.toolName
    ? { ...message, content: projectTool(ctx, { sessionId, tool: message.toolName, content: message.content }) }
    : message);
}

export function projectToolEvent<T extends { name: string; content?: MessageContent }>(ctx: Context, sessionId: string, event: T): T {
  return event.content === undefined ? event : {
    ...event, content: projectTool(ctx, { sessionId, tool: event.name, content: event.content })
  };
}
