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
          let result: 'allow' | 'ask' | undefined;
          for (const { context, callback } of ctx.events.listeners(
            'tools/decide',
            sessionEvent(ctx, request.sessionId),
          )) {
            const decision = await context.fiber.run(
              (signal) => callback({ ...structuredClone(input), signal }),
              signal,
            );
            if (decision === 'deny') return 'deny';
            if (decision === 'ask') result = 'ask';
            else if (decision === 'allow') result ??= 'allow';
            else if (decision !== undefined) throw new Error('Invalid tool policy decision');
          }
          return result;
        },
        harnessToolPolicy,
        (request, prompt, owner) => {
          const approvals = (owner ?? ctx).get('harnessApprovalRequests');
          if (!approvals) throw new Error('User approval is unavailable');
          return approvals.request(request.sessionId, prompt, request.signal);
        },
      ).service(),
    );
  },
};

export default plugin;
