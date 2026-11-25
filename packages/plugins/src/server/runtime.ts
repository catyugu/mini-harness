import { Context, Service } from 'mini-harness/cordis';
import type { ProfileConfigurationPort } from '@mini-harness/plugin-api/profile';
import { PluginHost } from './manager.ts';

export default {
  inject: ['harnessState', 'harnessProfile'],
  provide: [
    'harnessProfileScopes',
    'harnessPluginCatalog',
    'harnessProfileConfig',
    'harnessPluginSettings',
    'harnessPluginData',
    'harnessPluginSecrets',
    'harnessPluginChanges',
  ],
  apply(ctx: Context) {
    const profile = ctx.harnessProfile;
    const { paths } = ctx.harnessState;
    const root = ctx[Context.root];
    const host = new PluginHost(root, paths.plugins, profile, ctx, profile.entries);
    ctx.provide('harnessProfileScopes', host);
    ctx.provide('harnessPluginCatalog', host);
    ctx.provide(
      'harnessProfileConfig',
      Service.track<ProfileConfigurationPort>({
        get settings() {
          return host.settings;
        },
        update(patch, signal) {
          return host.update(patch, signal ?? Service.caller(this).fiber.signal);
        },
        forgetScopes: host.forgetScopes.bind(host),
        subscribe: host.subscribe.bind(host),
      }),
    );
    ctx.on('harness/start', () => host.start());
    ctx.on('harness/drain', () => host.drain());
    ctx.effect(() => () => host.close());
  },
};
