import type {} from '@mini-harness/settings/api';
import type {} from '@mini-harness/kernel/scopes';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import type {} from './store.js';

export interface SessionPermissionPort {
  tools(id: string): { readOnly: boolean; disabledTools: string[] };
}

declare module 'cordis' {
  interface Context { harnessSessionPermissions: SessionPermissionPort }
}

/** Interpret conversation and workspace restrictions at the permission boundary. */
export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:permissions', title: 'Session permissions', description: 'Inherited conversation restrictions', required: true,
  inject: ['harnessRegistry', 'harnessScopeDirectory', 'harnessSettingsStore'], provides: ['harnessSessionPermissions'],
  setup(ctx) {
    const { harnessRegistry: sessions, harnessScopeDirectory: directory, harnessSettingsStore: settings } = ctx;
    ctx.provide('harnessSessionPermissions', {
      tools(id: string) {
        const address = directory.address('session:' + id);
        const restrictions = settings.settings.scopes;
        return {
          readOnly: address.some(({ scope }) => scope.kind === 'session' && sessions.get(scope.sessionId)?.permission === 'readOnly'),
          disabledTools: address.flatMap(({ key }) => restrictions[key]?.disabledTools ?? [])
        };
      }
    });
  }
};
