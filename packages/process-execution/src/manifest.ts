import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { executeProcess } from './executor.ts';

export const metadata: PluginInfo = {
  title: 'Process execution',
  description: 'Isolated and explicitly authorized host processes',
};

const plugin: Plugin.Object = {
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
};

export default plugin;
