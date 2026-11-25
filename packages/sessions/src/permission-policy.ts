import type { Plugin } from 'mini-harness/cordis';
import type { ToolPolicy } from '@mini-harness/tools/policy';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  title: 'Tool permissions',
  description: 'Inherited conversation tool restrictions',
};

const plugin: Plugin.Object = {
  inject: ['harnessRegistry', 'harnessScopes', 'harnessSettingsStore'],
  provide: ['harnessToolPolicy'],
  apply(ctx) {
    const authorize: ToolPolicy = (id, { name, readOnly }) => {
      const address = ctx.harnessScopes.address(`session:${id}`);
      const settings = ctx.harnessSettingsStore.settings;
      if (address.some((key) => settings.scopes[key]?.disabledTools?.includes(name))) return false;
      const requiresReadOnly = address.some(
        (key) =>
          key.startsWith('session:') &&
          ctx.harnessRegistry.get(key.slice('session:'.length))?.permission === 'readOnly',
      );
      return !requiresReadOnly || readOnly;
    };
    ctx.provide('harnessToolPolicy', authorize);
  },
};

export default plugin;
