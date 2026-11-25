import type {} from '@mini-harness/plugin-api/scopes';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/sandbox/api';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { executeProcess } from './executor.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:process',
  title: 'Process execution',
  description: 'Isolated and explicitly authorized host processes',
  defaultEnabled: true,

  plugin: {
    inject: ['harnessSandbox', 'harnessScopes', 'harnessRegistry'],
    provide: ['harnessProcess'],
    apply(ctx) {
      ctx.provide('harnessProcess', {
        run(request: Parameters<typeof executeProcess>[0]) {
          return ctx.fiber.run((signal) => {
            const environment = ctx.harnessScopes.require(
              request.sessionId ? `session:${request.sessionId}` : undefined,
              'harnessSandbox',
            );
            const attachments = request.sessionId
              ? ctx.harnessRegistry.attachmentDirectory(request.sessionId)
              : undefined;
            return executeProcess({ ...request, signal }, environment, attachments);
          }, request.signal);
        },
      });
    },
  },
};
