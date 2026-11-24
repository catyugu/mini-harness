import { decisionHook, extension, type OrderedHook } from '@mini-harness/kernel/contributions';

import { registerToolBinding, type ToolDefinition, type ToolRegistrationOptions } from './api.js';

export interface ToolDecision {
  sessionId: string;
  tool: string;
  callId: string;
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export type ToolDecisionHandler = (request: ToolDecision) => 'deny' | undefined | Promise<'deny' | undefined>;

export const toolExtensions = {
  register: extension((source, definition: ToolDefinition | { name: string; bind(sessionId: string): ToolDefinition },
    options?: ToolRegistrationOptions) => {
    const tools = source.service('harnessTools');
    const bind = 'bind' in definition ? definition.bind : () => definition;
    return source.context.effect(() => tools[registerToolBinding](definition.name, bind, {
      access: options?.access, visible: options?.visible, source, scope: source.scopeKey
    }));
  }),
  decide: extension((source, handler: ToolDecisionHandler, order: number = 0) =>
    decisionHook(source, 'tool decision', handler, order, (context) => context.sessionId, (hook, active) =>
      source.context.on('harness/tool-decision', (id, hooks) => { if (active(id)) hooks.push(hook); }), (decision) => {
      if (decision !== 'deny') throw new Error('Invalid tool policy decision');
      return decision;
    }))
};

declare module 'cordis' {
  interface Events {
    'harness/tool-decision'(sessionId: string, handlers: OrderedHook<ToolDecisionHandler>[]): void;
  }
}
