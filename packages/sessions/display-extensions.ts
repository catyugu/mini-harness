import { extension, scopedHook, type OrderedHook } from '@mini-harness/kernel/contributions';
import type { MessageContent } from './message.js';

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
