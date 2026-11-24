import type {} from '@mini-harness/kernel/observations';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/sessions/store';
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
  private ready = false;

  get accepting() { return this.ready && !this.stopping; }

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
      () => this.settings, (key) => ctx.get('harnessScopeDirectory')?.address(key) ?? [], upgrade, paths.devPlugin,
      (id, key, patch, check) => this.configuration.writePlugin(id, key, patch, check).then(() => {}), authority);
    ctx.provide('harnessScopes', this.plugins);
    ctx.provide('harnessPluginCatalog', this.plugins);
  }

  get settings() { return this.configuration.settings; }
  get registry() { return this.plugins.ctx.harnessRegistry; }
  async start() {
    try {
      await this.plugins.start(this.settings);
      const pending: Promise<void>[] = [];
      this.plugins.ctx.emit('harness/startup', pending);
      await Promise.all(pending);
      this.ready = true;
    } catch (error) { await this.stop(); throw error; }
  }

  stop() {
    return this.stopping ??= this.shutdown();
  }

  private async shutdown() {
    this.ready = false;
    const mutations = this.mutations.close();
    const pending: Promise<void>[] = [];
    try {
      this.plugins.ctx.emit('harness/quiesce', pending);
      const results = await Promise.allSettled([mutations, ...pending]);
      await this.configuration.close();
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Application shutdown failed');
    } finally {
      await this.plugins.close();
    }
  }
}
