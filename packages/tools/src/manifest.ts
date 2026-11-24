import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/settings/api';
import { firstDecision, type OrderedHook } from '@mini-harness/kernel/contributions';
import type { ToolDecisionHandler } from './extensions.js';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { ToolRegistry } from './registry.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:tools', title: 'Tools', description: 'Tool registration and execution leases', required: true,
  inject: ['harnessScopes', 'harnessSettingsStore', 'harnessRegistry'], provides: ['harnessTools'],
  setup(ctx) {
    const { harnessScopes: scopes, harnessRegistry: sessions, harnessSettingsStore: settings } = ctx;
    ctx.provide('harnessTools', new ToolRegistry((id) => scopes.address(id),
      (request) => {
        const hooks: OrderedHook<ToolDecisionHandler>[] = [];
        ctx.emit('harness/tool-decision', request.sessionId, hooks);
        return firstDecision(hooks, request);
      }, (id) => {
        const ancestry = scopes.address(id);
        const restrictions = settings.settings.scopes;
        return {
          readOnly: ancestry.some((key) => key.startsWith('session:') && sessions.get(key.slice('session:'.length))?.permission === 'readOnly'),
          disabledTools: ancestry.flatMap((key) => restrictions[key]?.disabledTools ?? [])
        };
      }));
  }
};
