import type { Plugin } from 'mini-harness/cordis';
import { sessionEvent } from '@mini-harness/plugin-api/instance';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { ToolRegistry } from './registry.ts';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Tools',
  description: 'Tool registration and execution leases',
};

const plugin: Plugin.Object = {
  inject: ['harnessScopes', 'harnessToolPolicy'],
  provide: ['harnessTools'],
  apply(ctx) {
    const { harnessScopes: scopes, harnessToolPolicy } = ctx;
    ctx.provide(
      'harnessTools',
      new ToolRegistry(
        (id) => scopes.address(`session:${id}`),
        async (request) => {
          const { signal, ...input } = request;
          for (const { context, callback } of ctx.events.listeners(
            'tools/decide',
            sessionEvent(ctx, request.sessionId),
          )) {
            const decision = await context.fiber.run(
              (signal) => callback({ ...structuredClone(input), signal }),
              signal,
            );
            if (decision === undefined) continue;
            if (decision !== 'deny') throw new Error('Invalid tool policy decision');
            return decision;
          }
        },
        harnessToolPolicy,
      ).service(),
    );
  },
};

export default plugin;
