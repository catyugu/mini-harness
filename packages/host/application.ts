import { Context } from 'cordis';
import { authority, plugins } from './composition.js';
import { SettingsManager } from '@mini-harness/settings/manager';
import { PluginHost } from '@mini-harness/plugins/manager';
import { RouteRegistry } from '@mini-harness/transport/http';
import { MutationGate } from '@mini-harness/transport/mutations';
import type { NetworkPort } from '@mini-harness/contracts/routes';
import type { Paths } from '@mini-harness/contracts/config';

export class MiniHarnessRuntime {
  readonly plugins: PluginHost;
  readonly configuration: SettingsManager;
  private readonly mutations: MutationGate;
  private stopping?: Promise<void>;
  private readonly unsubscribeSettings: () => void;

  constructor(readonly paths: Paths, network?: NetworkPort,
    upgrade?: (path: string, handler: import('@mini-harness/contracts/routes').UpgradeHandler) => () => void) {
    const ctx = new Context();
    this.configuration = new SettingsManager(paths, () => this.plugins);
    const changes = new EventTarget();
    const emit = (domain: string) => changes.dispatchEvent(new CustomEvent('change', { detail: { domain } }));
    this.unsubscribeSettings = this.configuration.subscribe(() => emit('settings'));
    this.mutations = new MutationGate((scopes) => scopes ? ctx.get('harnessRuns')?.activeInScope(scopes) === true :
      Boolean(ctx.get('harnessRuns')?.size || ctx.get('harnessAgent')?.hasPending));
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
      () => this.settings, (id) => ctx.get('harnessRegistry')?.get(id), upgrade, paths.devPlugin,
      (id, key, patch, check) => this.configuration.writePlugin(id, key, patch, check).then(() => {}), authority);
    ctx.provide('harnessScopes', this.plugins);
    ctx.provide('harnessPluginCatalog', this.plugins);
  }

  get settings() { return this.configuration.settings; }
  get registry() { return this.plugins.ctx.harnessRegistry; }
  start() { return this.plugins.start(this.settings); }

  stop() {
    return this.stopping ??= this.shutdown();
  }

  private async shutdown() {
    const { harnessRuns: runs, harnessRegistry: registry } = this.plugins.ctx;
    registry?.close();
    const mutations = this.mutations.close();
    const settings = this.configuration.close();
    try {
      await runs?.stop();
      await Promise.all([mutations, settings]);
    } finally {
      try { await this.plugins.close(); }
      finally { this.unsubscribeSettings(); }
    }
  }
}
