import { setupPermissionSettings } from './permission-settings.js';
import type { ToolPolicy } from '@mini-harness/tools/policy';
import type {} from '@mini-harness/settings/api';
import type {} from '@mini-harness/kernel/scopes';
import type {} from './store.js';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:tool-policy', title: 'Tool permissions', description: 'Inherited restrictions and user tool grants', defaultEnabled: true,
  inject: ['harnessRegistry', 'harnessScopes', 'harnessSettingsStore'], provides: ['harnessToolPolicy'],
  setup(ctx) {
    const authorize: ToolPolicy = (id, { name, readOnly, pluginId, trusted }) => {
      const address = ctx.harnessScopes.address(`session:${id}`);
      const settings = ctx.harnessSettingsStore.settings;
      if (address.some((key) => settings.scopes[key]?.disabledTools?.includes(name))) return false;
      const requiresReadOnly = address.some((key) => key.startsWith('session:') &&
        ctx.harnessRegistry.get(key.slice('session:'.length))?.permission === 'readOnly');
      const grants = settings.readOnlyTools;
      return !requiresReadOnly || (readOnly &&
        (trusted || Boolean(pluginId && Object.hasOwn(grants, pluginId) && grants[pluginId].includes(name))));
    };
    ctx.provide('harnessToolPolicy', authorize);
  }
};

export const permissionSettingsManifest: PluginDescriptor = {
  id: 'core:permission-settings', scope: 'application', title: 'Tool grants',
  description: 'Manage read-only tool grants from a plugin’s settings',
  inject: ['harnessTools', 'harnessSettingsStore', 'harnessRoutes', 'harnessMutations'],
  setup: setupPermissionSettings,
  browserInject: ['miniSettingsRegistry'],
  browser: '/packages/sessions/src/browser/permission-settings.js'
};
