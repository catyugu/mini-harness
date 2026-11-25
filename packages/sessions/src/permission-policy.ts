import type { Plugin } from 'mini-harness/cordis';
import { setupPermissionSettings } from './permission-settings.ts';
import type { ToolPolicy } from '@mini-harness/tools/policy';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Tool permissions',
  description: 'Inherited restrictions and user tool grants',
};

const plugin: Plugin.Object = {
  inject: ['harnessRegistry', 'harnessScopes', 'harnessSettingsStore'],
  provide: ['harnessToolPolicy'],
  apply(ctx) {
    const authorize: ToolPolicy = (id, { name, readOnly, pluginId, trusted }) => {
      const address = ctx.harnessScopes.address(`session:${id}`);
      const settings = ctx.harnessSettingsStore.settings;
      if (address.some((key) => settings.scopes[key]?.disabledTools?.includes(name))) return false;
      const requiresReadOnly = address.some(
        (key) =>
          key.startsWith('session:') &&
          ctx.harnessRegistry.get(key.slice('session:'.length))?.permission === 'readOnly',
      );
      const grants = settings.readOnlyTools;
      return (
        !requiresReadOnly ||
        (readOnly &&
          (trusted ||
            Boolean(pluginId && Object.hasOwn(grants, pluginId) && grants[pluginId].includes(name))))
      );
    };
    ctx.provide('harnessToolPolicy', authorize);
  },
};

export default plugin;

export const permissionSettingsMetadata: PluginInfo = {
  scope: 'application',
  title: 'Tool grants',
  description: 'Manage read-only tool grants from a plugin’s settings',
  browser: '/packages/sessions/src/browser/permission-settings.js',
};

export const permissionSettings: Plugin.Object = {
  inject: ['harnessTools', 'harnessSettingsStore', 'harnessRoutes', 'harnessMutations'],
  apply: setupPermissionSettings,
};
