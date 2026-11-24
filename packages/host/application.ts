import { Context } from 'cordis';
import type { NativeAgent } from '@mini-harness/agent/agent';
import { plugins, trustedContributors } from './composition.js';
import { SettingsManager } from '@mini-harness/settings/manager';
import { PluginHost } from '@mini-harness/plugins/manager';
import { RouteRegistry } from '@mini-harness/transport/http';
import { MutationGate } from '@mini-harness/transport/mutations';
import type { ScopePort } from '@mini-harness/contracts/capabilities';
import type { NetworkPort } from '@mini-harness/contracts/routes';
import type { Paths } from '@mini-harness/contracts/config';

export class MiniHarnessRuntime {
  readonly plugins: PluginHost;
  readonly configuration: SettingsManager;
  private readonly unsubscribeSettings: () => void;

  constructor(readonly paths: Paths, network?: NetworkPort,
    upgrade?: (path: string, handler: import('@mini-harness/contracts/routes').UpgradeHandler) => () => void) {
    const ctx = new Context();
    this.configuration = new SettingsManager(paths, (settings) => this.plugins.effective(settings));
    const changes = new EventTarget();
    const emit = (domain: string) => changes.dispatchEvent(new CustomEvent('change', { detail: { domain } }));
    this.unsubscribeSettings = this.configuration.subscribe(() => emit('settings'));
    const root = {
      harnessState: { paths },
      harnessScopes: {
        prepare: (id: string, signal?: AbortSignal) => this.plugins.prepare(id, signal),
        require: (id, service) => this.plugins.require(id, service),
        optional: (id, service) => this.plugins.optional(id, service),
        toolRestrictions: (id) => this.plugins.toolRestrictions(id),
        address: (id: string) => this.plugins.address(id),
        release: (ids: string[], workspaceId?: string) => this.plugins.release(ids, workspaceId)
      } satisfies ScopePort,
      harnessSettings: () => this.configuration.settings,
      harnessSettingsStore: this.configuration,
      harnessRoutes: new RouteRegistry(),
      ...(network ? { harnessNetwork: network } : {}),
      harnessMutations: new MutationGate((scopes) => scopes ? ctx.get('harnessRuns')?.activeInScope(scopes) === true :
        Boolean(ctx.get('harnessRuns')?.size || ctx.get('harnessAgent')?.hasPending)),
      harnessChanges: changes,
      harnessUpdateSettings: (patch: unknown) => this.updateSettings(patch),
      harnessWriteBrowserConfig: (id: string, patch: unknown, signal: AbortSignal) =>
        this.configuration.writePlugin(id, undefined, patch, this.plugins, () => {
          signal.throwIfAborted();
          this.plugins.assertBrowserConfigurable(id);
        }).then(() => {}),
      harnessPluginCatalog: {
        metadata: () => this.plugins.metadata(),
        reserved: (id: string) => this.plugins.reserved(id),
        browser: () => this.plugins.browser(),
        diagnostics: () => this.plugins.diagnostics()
      }
    };
    for (const [name, service] of Object.entries(root)) ctx.provide(name, service);
    this.plugins = new PluginHost(ctx, paths.plugins, plugins, Object.keys(root),
      () => this.settings, (id) => ctx.get('harnessRegistry')?.get(id), upgrade, paths.devPlugin,
      (id, key, patch, check) => this.configuration.writePlugin(id, key, patch, this.plugins, check).then(() => {}), trustedContributors);
  }

  get settings() { return this.configuration.settings; }
  get registry() { return this.plugins.ctx.harnessRegistry; }
  get agent() { return this.plugins.ctx.harnessAgent as NativeAgent; }
  get runs() { return this.plugins.ctx.harnessRuns; }
  get delegation() { return this.plugins.ctx.harnessDelegation; }
  get hasActiveWork() { return this.runs.size > 0 || this.agent.hasPending; }

  start() { return this.plugins.start(this.settings); }
  createConversation(input: { workspaceId?: string } = {}) { return this.registry.create(input); }
  getConversation(id: string) { return this.plugins.ctx.harnessConversationView.read(id); }
  export(ids: string[]) { return this.registry.export(ids); }
  delete(ids: string[]) { return this.registry.delete(ids); }
  async updateSettings(patch: unknown) {
    try { return await this.configuration.update(patch, this.plugins); }
    finally {
      this.plugins.ctx.harnessChanges.dispatchEvent(new CustomEvent('change', { detail: { domain: 'plugins' } }));
    }
  }

  async stop() {
    const { harnessRuns: runs, harnessRegistry: registry } = this.plugins.ctx;
    registry?.close();
    try { await runs?.stop(); }
    finally {
      try { await this.plugins.close(); }
      finally { this.unsubscribeSettings(); }
    }
  }
}
