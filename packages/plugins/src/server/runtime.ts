import { Context } from 'mini-harness/cordis';
import { PluginHost } from './manager.ts';

export default {
  inject: ['harnessState', 'harnessProfile', 'harnessSettingsStore', 'harnessMutations', 'harnessChanges'],
  provide: [
    'harnessScopes',
    'harnessPluginCatalog',
    'harnessComposition',
    'harnessScopedRequests',
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
      () => settings.settings,
      async (id, key, patch, check) => {
        await settings.writePlugin(id, key, patch, check);
      },
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
