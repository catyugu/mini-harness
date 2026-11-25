import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/plugin-api/profile';
import type {} from '@mini-harness/settings/api';
import type {} from '@mini-harness/transport/runtime';
import { Context } from 'mini-harness/cordis';
import { PluginHost } from './manager.js';

export default {
  inject: ['harnessState', 'harnessProfile', 'harnessSettingsStore', 'harnessMutations', 'harnessChanges'],
  provide: [
    'harnessScopes',
    'harnessPluginCatalog',
    'harnessComposition',
    'harnessPluginRoutes',
    'harnessPluginSettings',
    'harnessPluginData',
    'harnessPluginSecrets',
    'harnessPluginChanges',
  ],
  apply(ctx: Context) {
    const profile = ctx.harnessProfile;
    const settings = ctx.harnessSettingsStore;
    const { paths } = ctx.harnessState;
    const root = ctx[Context.root];
    const host = new PluginHost(
      root,
      paths.plugins,
      profile.descriptors,
      ['harnessState', 'harnessProfile', 'harnessLaunch', ...profile.infrastructure],
      () => settings.settings,
      (path, handler) => {
        const upgrades = root.get('harnessUpgrades');
        if (!upgrades) throw new Error('WebSocket transport is unavailable in this Profile');
        return upgrades.register(path, handler);
      },
      paths.devPlugin,
      async (id, key, patch, check) => {
        await settings.writePlugin(id, key, patch, check);
      },
      profile.nativeEntries,
      ctx,
      profile.entries,
    );
    ctx.provide('harnessScopes', host);
    ctx.provide('harnessPluginCatalog', host);
    ctx.provide('harnessComposition', host);
    ctx.on('harness/start', () => host.start(settings.settings));
    ctx.effect(() => () => host.close());
  },
};
