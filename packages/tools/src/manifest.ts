import type { Plugin } from 'mini-harness/cordis';
import { scopeTarget } from '@mini-harness/plugin-api/scopes';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { ToolRegistry } from './registry.ts';

export const metadata: PluginInfo = {
  title: 'Tools',
  description: 'Tool registration and execution leases',
};

const plugin: Plugin.Object = {
  inject: ['harnessToolPolicy'],
  provide: ['harnessTools'],
  apply(ctx) {
    const { harnessToolPolicy } = ctx;
    ctx.provide(
      'harnessTools',
      new ToolRegistry(
        async (request, scope) => {
          const { signal, ...input } = request;
          for (const { context, callback } of ctx.events.listeners(
            'tools/decide',
            scopeTarget(ctx, scope),
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
