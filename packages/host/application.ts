import { Context } from 'cordis';
import { system, builtins } from './composition.js';
import { SettingsManager } from '../settings/manager.js';
import { PluginHost } from '../plugins/manager.js';
import { RouteRegistry } from '../transport/http.js';
import { MutationGate } from '../transport/mutations.js';
import type { Paths, SettingsPatch } from '../contracts/config.js';

/** Pure application composition. Concrete capability lifecycles are owned by Cordis plugins. */
export class MiniHarnessRuntime {
  readonly plugins: PluginHost;
  readonly configuration: SettingsManager;

  constructor(readonly paths: Paths) {
    const ctx = new Context();
    this.configuration = new SettingsManager(paths);
    ctx.provide('harnessState', { paths });
    ctx.provide('harnessSettings', () => this.configuration.settings);
    ctx.provide('harnessSettingsStore', this.configuration);
    ctx.provide('harnessRoutes', new RouteRegistry());
    ctx.provide('harnessMutations', new MutationGate());
    this.plugins = new PluginHost(ctx, paths.plugins, system, builtins,
      (id, pluginId) => ctx.harnessPi.records(id, pluginId));
    ctx.provide('harnessUpdateSettings', (patch) => this.updateSettings(patch));
    ctx.provide('harnessPluginCatalog', {
      metadata: () => this.plugins.metadata(),
      configuration: (id) => this.plugins.configuration(id),
      reserved: (id) => this.plugins.reserved(id)
    });
  }

  get settings() { return this.configuration.settings; }
  get registry() { return this.plugins.ctx.harnessRegistry; }
  get pi() { return this.plugins.ctx.harnessPi; }
  get runs() { return this.plugins.ctx.harnessRuns; }
  get delegation() { return this.plugins.ctx.harnessDelegation; }
  get hasActiveWork() { return this.plugins.ctx.harnessOperations.hasActiveWork; }

  start() { return this.plugins.configure(this.settings); }
  createConversation(input: { workspaceId?: string } = {}) {
    return this.plugins.ctx.harnessOperations.createConversation(input);
  }
  deleteWorkspace(id: string) { return this.plugins.ctx.harnessOperations.deleteWorkspace(id); }
  getConversation(id: string) { return this.plugins.ctx.harnessOperations.getConversation(id); }
  export(ids: string[]) { return this.plugins.ctx.harnessOperations.export(ids); }
  delete(ids: string[]) { return this.plugins.ctx.harnessOperations.delete(ids); }
  reviseAndStart(id: string, input: Parameters<import('../contracts/services.js').ConversationPort['reviseAndStart']>[1]) {
    return this.plugins.ctx.harnessOperations.reviseAndStart(id, input);
  }
  updateSettings(patch: SettingsPatch) {
    return this.configuration.update(patch, this.plugins, this.plugins.ctx.harnessOperations, this.pi);
  }
  async stop() {
    const pi = this.pi;
    await this.plugins.ctx.harnessOperations.stop();
    await this.plugins.close();
    await pi.models?.settleCredentialWrites();
  }
}
