import type {} from '@mini-harness/tools/policy';
import type {} from '@mini-harness/settings/api';
import type {} from '@mini-harness/kernel/scopes';
import type {} from './store.js';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:tool-policy', title: 'Tool permissions', description: 'Inherited restrictions and user tool grants', required: true,
  inject: ['harnessRegistry', 'harnessScopes', 'harnessSettingsStore'], provides: ['harnessToolPolicy'],
  setup(ctx) {
    ctx.provide('harnessToolPolicy', (id: string) => {
      const address = ctx.harnessScopes.address(`session:${id}`);
      const settings = ctx.harnessSettingsStore.settings;
      return {
        readOnly: address.some((key) => key.startsWith('session:') &&
          ctx.harnessRegistry.get(key.slice('session:'.length))?.permission === 'readOnly'),
        disabledTools: address.flatMap((key) => settings.scopes[key]?.disabledTools ?? []),
        readOnlyTools: settings.readOnlyTools
      };
    });
  }
};
