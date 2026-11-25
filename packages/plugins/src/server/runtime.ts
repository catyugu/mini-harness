import { Context } from 'mini-harness/cordis';
import { PluginHost } from './manager.ts';

export default {
  inject: ['harnessState', 'harnessProfile', 'harnessSettingsStore', 'harnessMutations', 'harnessChanges'],
  provide: [
    'harnessProfileScopes',
    'harnessPluginCatalog',
    'harnessComposition',
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
      profile,
      () => settings.settings,
      async (id, key, patch, check) => {
        await settings.writePlugin(id, key, patch, check);
      },
      ctx,
      profile.entries,
    );
    ctx.provide('harnessProfileScopes', host);
    ctx.provide('harnessPluginCatalog', host);
    ctx.provide('harnessComposition', host);
    ctx.on('harness/start', () => host.start(settings.settings));
    ctx.effect(() => () => host.close());
  },
};
