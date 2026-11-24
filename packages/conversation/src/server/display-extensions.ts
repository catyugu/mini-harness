import { extension, orderHooks, scopedHook, type OrderedHook } from '@mini-harness/kernel/contributions';
import type { Context } from 'cordis';
import type { SessionEntry } from '@mini-harness/sessions/log-api';
import type { BusinessRecord } from '../shared/api.js';
import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';

export interface ToolProjection {
  sessionId: string;
  tool: string;
  content: MessageContent;
}

export type ToolProjectionHandler = (projection: ToolProjection) => MessageContent | undefined;

export interface BusinessRecordContext {
  sessionId: string;
  id: string;
  timestamp: string;
  data: unknown;
}
export type BusinessRecordHandler = (record: BusinessRecordContext) => BusinessRecord['presentation'];

export const sessionDisplayExtensions = {
  record: extension((source, handler: BusinessRecordHandler) => {
    if (typeof handler !== 'function') throw new Error('Expected a record presentation function');
    return source.context.on('harness/record-projection', (id, pluginId, handlers) => {
      if (source.pluginId === pluginId && source.visible(id))
        handlers.push({ depth: source.depth(id), invoke: handler, instanceId: source.instanceId });
    });
  }),
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
    'harness/record-projection'(sessionId: string, pluginId: string, handlers: { depth: number; invoke: BusinessRecordHandler; instanceId: string }[]): void;
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

export function projectRecords(ctx: Context, sessionId: string, branch: SessionEntry[]): BusinessRecord[] {
  let afterMessageId: string | undefined;
  const records: BusinessRecord[] = [];
  for (const entry of branch) {
    if (entry.type === 'message' || entry.type === 'tool-accepted') afterMessageId = entry.id;
    if (entry.type !== 'custom') continue;
    const record: BusinessRecord = { id: entry.id, pluginId: entry.namespace, timestamp: entry.timestamp, afterMessageId };
    const handlers: { depth: number; invoke: BusinessRecordHandler; instanceId: string }[] = [];
    ctx.emit('harness/record-projection', sessionId, entry.namespace, handlers);
    for (const { invoke, instanceId } of handlers.sort((a, b) => b.depth - a.depth)) {
      try {
        const result = invoke({ sessionId, id: entry.id, timestamp: entry.timestamp, data: structuredClone(entry.data) });
        if (result === undefined) continue;
        if (!result || typeof result.kind !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(result.kind))
          throw new Error('Invalid record presentation kind');
        record.presentation = { kind: result.kind, data: JSON.parse(JSON.stringify(result.data ?? null)) };
        break;
      } catch (error) { ctx.logger.warn('Plugin %s record projection failed: %s', instanceId, String(error)); }
    }
    records.push(record);
  }
  return records;
}
