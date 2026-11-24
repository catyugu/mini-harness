import { extension, orderedHook, type OrderedHook } from './contributions.js';
import type { ToolDecision, ToolProjection } from './events.js';
import type { ToolResultTransform } from './extensions.js';
import type { MessageContent } from './message.js';
import { isToolContent, type ToolDefinition } from './tools.js';

export const toolExtensions = {
  register: extension((source, tool: ToolDefinition) =>
    source.context.effect(() => source.service('harnessTools').register(tool.name, () => tool,
      source.visible, source.scopeKey))),
  result: extension((source, handler: ToolResultTransform, order: number = 0) =>
    orderedHook(source, 'tool result', handler, order, (hook, active) =>
      source.context.on('harness/tool-result', (id, hooks) => { if (active(id)) hooks.push(hook); }))),
  decide: extension((source, handler: (request: ToolDecision) => 'deny' | undefined | Promise<'deny' | undefined>) =>
    source.context.on('harness/tool-decision', ({ signal, ...request }) => {
      if (!source.visible(request.sessionId)) return;
      return source.run('tool decision', async (signal) => {
        const decision = await handler({ ...structuredClone(request), signal });
        if (decision !== undefined && decision !== 'deny') throw new Error('Invalid tool policy decision');
        return decision;
      }, signal);
    })),
  project: extension((source, handler: (projection: ToolProjection) => MessageContent | undefined) =>
    source.context.on('harness/tool-projection', (request, next) => {
      const content = next();
      if (!source.visible(request.sessionId)) return content;
      try {
        const result = handler(structuredClone({ ...request, content }));
        if (result === undefined) return content;
        if (typeof result !== 'string' && !isToolContent(result)) throw new Error('Invalid tool projection');
        return structuredClone(result);
      } catch (error) {
        source.context.logger.warn('Plugin %s tool projection failed: %s', source.instanceId, String(error));
        return content;
      }
    }))
};

declare module 'cordis' {
  interface Events {
    'harness/tool-result'(sessionId: string, handlers: OrderedHook<ToolResultTransform>[]): void;
    'harness/tool-decision'(request: ToolDecision): 'deny' | undefined | Promise<'deny' | undefined>;
    'harness/tool-projection'(request: ToolProjection, next: () => MessageContent): MessageContent;
  }
}
