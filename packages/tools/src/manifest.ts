import type {} from '@mini-harness/kernel/scopes';
import { firstDecision, type OrderedHook } from '@mini-harness/kernel/contributions';
import type { ToolDecisionHandler } from './extensions.js';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import type {} from './policy.js';
import { ToolRegistry } from './registry.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:tools', title: 'Tools', description: 'Tool registration and execution leases', required: true,
  inject: ['harnessScopes', 'harnessToolPolicy'], provides: ['harnessTools'],
  setup(ctx) {
    const { harnessScopes: scopes, harnessToolPolicy } = ctx;
    ctx.provide('harnessTools', new ToolRegistry((id) => scopes.address(`session:${id}`),
      (request) => {
        const hooks: OrderedHook<ToolDecisionHandler>[] = [];
        ctx.emit('harness/tool-decision', request.sessionId, hooks);
        return firstDecision(hooks, request);
      }, harnessToolPolicy));
  }
};
