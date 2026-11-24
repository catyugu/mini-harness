import { firstDecision, type OrderedHook } from '@mini-harness/contracts/contributions';
import type { ToolDecisionHandler } from '@mini-harness/contracts/tool-extensions';
import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { ToolRegistry } from './registry.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:tools', title: 'Tools', description: 'Tool registration and execution leases', required: true,
  inject: ['harnessScopes'], provides: ['harnessTools'],
  setup(ctx) {
    ctx.provide('harnessTools', new ToolRegistry((id) => ctx.harnessScopes.address(id),
      (request) => {
        const hooks: OrderedHook<ToolDecisionHandler>[] = [];
        ctx.emit('harness/tool-decision', request.sessionId, hooks);
        return firstDecision(hooks, request);
      }, (id) => ctx.harnessScopes.toolRestrictions(id)));
  }
};
