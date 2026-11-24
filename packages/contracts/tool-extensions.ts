import { decisionHook, extension, orderedHook, scopedHook, type OrderedHook, type Transform } from './contributions.js';
import type { StepContext } from './agent-extensions.js';
import type { ToolResult } from './tools.js';
import type { MessageContent } from './message.js';
import { registerToolBinding, type ToolDefinition, type ToolRegistrationOptions } from './tools.js';

export interface ToolDecision {
  sessionId: string;
  tool: string;
  callId: string;
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export interface ToolProjection {
  sessionId: string;
  tool: string;
  content: MessageContent;
}

export interface ToolResultContext extends StepContext {
  readonly callId: string;
  readonly tool: string;
}

export type ToolDecisionHandler = (request: ToolDecision) => 'deny' | undefined | Promise<'deny' | undefined>;
export type ToolProjectionHandler = (projection: ToolProjection) => MessageContent | undefined;

export type ToolResultTransform = Transform<ToolResult['content'], ToolResultContext>;

export const toolExtensions = {
  register: extension((source, definition: ToolDefinition | { name: string; bind(sessionId: string): ToolDefinition },
    options?: ToolRegistrationOptions) => {
    const tools = source.service('harnessTools');
    const bind = 'bind' in definition ? definition.bind : () => definition;
    return source.context.effect(() => tools[registerToolBinding](definition.name, bind, {
      access: options?.access, visible: options?.visible, source, scope: source.scopeKey
    }));
  }),
  result: extension((source, handler: ToolResultTransform, order: number = 0) =>
    orderedHook(source, 'tool result', handler, order, (hook, active) =>
      source.context.on('harness/tool-result', (id, hooks) => { if (active(id)) hooks.push(hook); }))),
  decide: extension((source, handler: ToolDecisionHandler, order: number = 0) =>
    decisionHook(source, 'tool decision', handler, order, (hook, active) =>
      source.context.on('harness/tool-decision', (id, hooks) => { if (active(id)) hooks.push(hook); }), (decision) => {
      if (decision !== 'deny') throw new Error('Invalid tool policy decision');
      return decision;
    })),
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
    'harness/tool-result'(sessionId: string, handlers: OrderedHook<ToolResultTransform>[]): void;
    'harness/tool-decision'(sessionId: string, handlers: OrderedHook<ToolDecisionHandler>[]): void;
    'harness/tool-projection'(sessionId: string, handlers: OrderedHook<ToolProjectionHandler>[]): void;
  }
}
