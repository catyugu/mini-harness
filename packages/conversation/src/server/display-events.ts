import { scopeTarget } from '@mini-harness/plugin-api/scopes';
import type { Context } from 'mini-harness/cordis';
import type { HistoryEntry, MessageContent, ViewMessage } from '@mini-harness/sessions/message';

export interface ToolProjection {
  sessionId: string;
  tool: string;
  content: MessageContent;
}

export type ToolProjectionHandler = (projection: ToolProjection) => MessageContent | undefined;

declare module 'mini-harness/cordis' {
  interface Events {
    'conversation/tool-projection': ToolProjectionHandler;
  }
}

export function projectTool(ctx: Context, projection: ToolProjection) {
  let { content } = projection;
  for (const { context, callback } of ctx.events.listeners(
    'conversation/tool-projection',
    scopeTarget(ctx, ctx.harnessSessions.runScope(projection.sessionId)),
  )) {
    try {
      const result = callback(structuredClone({ ...projection, content }));
      if (result === undefined) continue;
      if (
        typeof result !== 'string' &&
        (!Array.isArray(result) || !result.every((block) => block && typeof block.type === 'string'))
      )
        throw new Error('Invalid tool projection');
      content = structuredClone(result);
    } catch (error) {
      context.logger.warn('Tool projection failed: %s', String(error));
    }
  }
  return content;
}

export function projectHistory(ctx: Context, sessionId: string, timeline: HistoryEntry[]): HistoryEntry[] {
  return timeline.map((entry) =>
    entry.type === 'message' && entry.role === 'toolResult'
      ? projectToolResult(ctx, sessionId, entry)
      : entry,
  );
}

export function projectToolResult(
  ctx: Context,
  sessionId: string,
  message: Extract<ViewMessage, { role: 'toolResult' }>,
): Extract<ViewMessage, { role: 'toolResult' }> {
  return {
    ...message,
    content: projectTool(ctx, { sessionId, tool: message.toolName, content: message.content }),
  };
}

export function projectToolEvent<T extends { name: string; content?: MessageContent }>(
  ctx: Context,
  sessionId: string,
  event: T,
): T {
  return event.content === undefined
    ? event
    : {
        ...event,
        content: projectTool(ctx, { sessionId, tool: event.name, content: event.content }),
      };
}
