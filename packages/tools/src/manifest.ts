import type { Plugin } from 'mini-harness/cordis';
import { sessionEvent } from '@mini-harness/plugin-api/instance';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { ToolRegistry } from './registry.ts';

export const metadata: PluginInfo = {
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
          let args: Record<string, unknown> | undefined;
          for (const { context, callback } of ctx.events.listeners(
            'tools/pre-execute',
            sessionEvent(ctx, request.sessionId),
          )) {
            const decision = await context.fiber.run(
              (signal) => callback({ ...input, arguments: structuredClone(args ?? input.arguments), signal }),
              signal,
            );
            if (decision === undefined) continue;
            if (decision === 'deny') return decision;
            if (!decision || typeof decision.arguments !== 'object' || !decision.arguments || Array.isArray(decision.arguments))
              throw new Error('Invalid tool preparation');
            args = structuredClone(decision.arguments);
          }
          return args === undefined ? undefined : { arguments: args };
        },
        harnessToolPolicy,
        (id) => ctx.events.listeners('tools/pre-execute', sessionEvent(ctx, id)).length > 0,
      ).service(),
    );
  },
};

export default plugin;
