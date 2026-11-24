import { Context } from 'cordis';
import { authority, plugins } from './composition.js';
import { SettingsManager } from '@mini-harness/settings/manager';
import { PluginHost } from '@mini-harness/plugins/manager';
import { RouteRegistry } from '@mini-harness/transport/router';
import { ProjectionChanges } from '@mini-harness/transport/projections';
import { MutationGate } from './mutations.js';
import type { NetworkPort } from '@mini-harness/transport/routes';
import type { Paths } from '@mini-harness/platform/runtime-paths';

export class MiniHarnessRuntime {
  readonly plugins: PluginHost;
  readonly configuration: SettingsManager;
  private readonly mutations: MutationGate;
  private stopping?: Promise<void>;

  constructor(readonly paths: Paths, network?: NetworkPort,
    upgrade?: (path: string, handler: import('@mini-harness/transport/routes').UpgradeHandler) => () => void) {
    const ctx = new Context();
    this.configuration = new SettingsManager(paths, () => this.plugins);
    const changes = new ProjectionChanges();
    this.mutations = new MutationGate();
    const root = {
      harnessState: { paths },
      harnessSettingsStore: this.configuration,
      harnessRoutes: new RouteRegistry(),
      ...(network ? { harnessNetwork: network } : {}),
      harnessMutations: this.mutations,
      harnessChanges: changes
    };
    for (const [name, service] of Object.entries(root)) ctx.provide(name, service);
    this.plugins = new PluginHost(ctx, paths.plugins, plugins, [...Object.keys(root), 'harnessScopes', 'harnessPluginCatalog'],
      () => this.settings, upgrade, paths.devPlugin,
      (id, key, patch, check) => this.configuration.writePlugin(id, key, patch, check).then(() => {}), authority);
    ctx.provide('harnessScopes', this.plugins);
    ctx.provide('harnessPluginCatalog', this.plugins);
  }

  get settings() { return this.configuration.settings; }
  async start() {
    try { await this.plugins.start(this.settings); }
    catch (error) {
      try { await this.stop(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Application startup and cleanup failed'); }
      throw error;
    }
  }

  stop() {
    return this.stopping ??= this.shutdown();
  }

  private async shutdown() {
    this.mutations.seal();
    try {
      await this.plugins.ctx.parallel('harness/quiesce');
    } finally {
      await this.mutations.close();
      await this.configuration.close();
      await this.plugins.close();
    }
  }
}
