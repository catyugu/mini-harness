import type {} from '@mini-harness/plugin-api/scopes';
import { sessionEvent } from '@mini-harness/plugin-api/instance';
import type {} from './events.js';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import type {} from './policy.js';
import { ToolRegistry } from './registry.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  protectServices: ['harnessTools'],
  id: 'core:tools', title: 'Tools', description: 'Tool registration and execution leases', defaultEnabled: true,

  plugin: {
    inject: ['harnessScopes', 'harnessToolPolicy'],
    provide: ['harnessTools'],
    apply(ctx) {
      const { harnessScopes: scopes, harnessToolPolicy } = ctx;
      ctx.provide('harnessTools', (new ToolRegistry((id) => scopes.address(`session:${id}`),
        async (request) => {
          const { signal, ...input } = request;
          for (const { context, callback } of ctx.events.listeners('tools/decide', sessionEvent(ctx, request.sessionId))) {
            const decision = await context.fiber.run(signal => callback({ ...structuredClone(input), signal }), signal);
            if (decision === undefined) continue;
            if (decision !== 'deny') throw new Error('Invalid tool policy decision');
            return decision;
          }
        }, harnessToolPolicy)).service());
    }
  }
};
