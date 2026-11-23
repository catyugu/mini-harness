import { Context } from 'cordis';
import { plugins } from './composition.js';
import { upgrade } from './upgrade.js';
import { SettingsManager } from '../settings/manager.js';
import { PluginHost } from '../plugins/manager.js';
import { RouteRegistry } from '../transport/http.js';
import { MutationGate } from '../transport/mutations.js';
import type { Paths, SettingsPatch } from '../contracts/config.js';

export class MiniHarnessRuntime {
  readonly plugins: PluginHost;
  readonly configuration: SettingsManager;

  constructor(readonly paths: Paths) {
    const ctx = new Context();
    upgrade(paths);
    this.configuration = new SettingsManager(paths, (settings) => this.plugins.effective(settings));
    const changes = new EventTarget();
    const emit = (domain: string) => changes.dispatchEvent(new CustomEvent('change', { detail: { domain } }));
    this.configuration.subscribe(() => emit('settings'));
    const root = {
      harnessState: { paths },
      harnessSettings: () => this.configuration.settings,
      harnessSettingsStore: this.configuration,
      harnessRoutes: new RouteRegistry(),
      harnessMutations: new MutationGate(),
      harnessChanges: changes,
      harnessUpdateSettings: (patch: SettingsPatch) => this.updateSettings(patch),
      harnessPluginCatalog: {
        metadata: () => this.plugins.metadata(),
        reserved: (id: string) => this.plugins.reserved(id),
        browser: () => this.plugins.browser()
      }
    };
    for (const [name, service] of Object.entries(root)) ctx.provide(name, service);
    this.plugins = new PluginHost(ctx, paths.plugins, plugins, Object.keys(root),
      (id, pluginId) => ctx.harnessPi.records(id, pluginId));
  }

  get settings() { return this.configuration.settings; }
  get registry() { return this.plugins.ctx.harnessRegistry; }
  get pi() { return this.plugins.ctx.harnessPi; }
  get runs() { return this.plugins.ctx.harnessRuns; }
  get delegation() { return this.plugins.ctx.harnessDelegation; }
  get hasActiveWork() { return this.runs.size > 0 || this.pi.hasPending; }

  start() { return this.plugins.start(this.settings); }
  createConversation(input: { workspaceId?: string } = {}) { return this.registry.create(input); }
  getConversation(id: string) { return this.plugins.ctx.harnessConversationView.read(id); }
  export(ids: string[]) { return this.registry.export(ids); }
  delete(ids: string[]) { return this.registry.delete(ids); }
  async updateSettings(patch: SettingsPatch) {
    try { return await this.configuration.update(patch, this.plugins); }
    finally {
      this.plugins.ctx.harnessChanges.dispatchEvent(new CustomEvent('change', { detail: { domain: 'plugins' } }));
    }
  }

  async stop() {
    const { harnessPi: pi, harnessRuns: runs, harnessRegistry: registry } = this.plugins.ctx;
    registry?.close();
    await Promise.allSettled([runs?.stop(), ...pi?.pending ?? []]);
    pi?.close();
    await this.plugins.close();
    await pi?.models.settleCredentialWrites();
  }
}
