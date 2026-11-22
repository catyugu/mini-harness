import { Context } from 'cordis';
import { isDeepStrictEqual } from 'node:util';
import { PluginHost } from './plugins.js';
import { SessionRegistry, type ModelChoice } from '../registry.js';
import { mergeSettings, readSettings, writeJson, type Paths, type SettingsPatch } from '../config.js';
import { builtins, Delegation } from '../builtins/index.js';
import { ToolRegistry } from './plugin-api.js';
import { RouteRegistry } from '../http.js';
import { PiSessions } from '../pi-sessions.js';
import { Runs } from '../runs.js';

export class MiniHarnessRuntime {
  settings: ReturnType<typeof readSettings>;
  readonly registry: SessionRegistry;
  readonly plugins: PluginHost;
  readonly pi: PiSessions;
  readonly runs: Runs;
  readonly delegation: Delegation;
  private configuring?: Promise<void>;
  private readonly deleting = new Set<string>();
  private stopping = false;

  constructor(readonly paths: Paths) {
    this.settings = readSettings(paths);
    this.registry = new SessionRegistry(paths);
    const ctx = new Context();
    const assertAvailable = (id: string) => this.assertAvailable(id);
    this.pi = new PiSessions(paths, this.registry, ctx, () => this.settings.model,
      (model) => this.rememberModel(model), assertAvailable, (id) => this.runs.active(id));
    this.delegation = new Delegation(this.registry, this.pi, () => this.runs, () => this.settings.subagents, assertAvailable);
    this.runs = new Runs(this.registry, this.pi, () => this.settings.model, assertAvailable,
      (record, task, signal) => this.delegation.schedule(record, task, signal));
    this.plugins = new PluginHost(ctx, paths.plugins, builtins, (id, pluginId) => this.pi.records(id, pluginId));
    ctx.provide('harnessModels', { list: () => this.pi.availableModels() });
    ctx.provide('harnessSessions', { get: (id) => this.registry.get(id), list: () => this.registry.list() });
    ctx.provide('harnessState', { paths });
    ctx.provide('harnessSettings', () => this.settings);
    ctx.provide('harnessTools', new ToolRegistry());
    ctx.provide('harnessRoutes', new RouteRegistry());
    ctx.provide('harnessWorkspace', { resolve: (id) => this.registry.workspacePath(id) });
    ctx.provide('harnessSessionChanged', (id) => this.registry.notify(id));
    ctx.provide('harnessDelegation', this.delegation);
    ctx.provide('harnessRevision', { reviseAndStart: (id, input) => this.reviseAndStart(id, input) });
  }

  async start() {
    await this.pi.start();
    await this.plugins.configure(this.settings);
  }

  get hasActiveWork() { return this.runs.size > 0 || this.pi.hasPending; }

  private assertAvailable(id?: string) {
    if (this.configuring || this.stopping) throw new Error('Agent service is unavailable during reconfiguration or shutdown');
    if (id && this.deleting.has(id)) throw new Error('Conversation is being deleted');
  }

  private rememberModel(model: ModelChoice) {
    if (isDeepStrictEqual(this.settings.model, model)) return;
    const next = mergeSettings(this.settings, { model });
    writeJson(this.paths.settings, next);
    this.settings = next;
  }

  async getConversation(id: string) {
    const session = await this.pi.open(id);
    return { ...this.registry.get(id), messages: this.pi.messages(id), leafId: session.sessionManager.getLeafId(), model: this.pi.modelInfo(session.model),
      selectedModel: { ...this.settings.model }, thinkingLevel: session.thinkingLevel, ...this.runs.view(id),
      queue: this.pi.queue(session) };
  }

  export(ids: string[]) {
    const all = this.registry.descendants(ids);
    if (all.some((id) => this.runs.active(id) || this.pi.openingSession(id)))
      throw new Error('Stop active conversations before exporting them');
    return this.registry.export(ids);
  }

  async delete(ids: string[]) {
    const all = this.registry.descendants(ids);
    if (all.some((id) => this.deleting.has(id))) throw new Error('Conversation is being deleted');
    for (const id of all) this.deleting.add(id);
    try {
      for (const id of ids) this.runs.cancel(id);
      await Promise.allSettled(all.flatMap((id) => [this.runs.completion(id), this.pi.openingSession(id)]));
      for (const id of all) this.pi.release(id);
      return this.registry.delete(ids);
    } finally { for (const id of all) this.deleting.delete(id); }
  }

  async reviseAndStart(id: string, input: { sourceEntryId: string; expectedLeafId: string | null; message: string;
    attachments?: import('../input.js').Attachment[]; model?: ModelChoice; thinkingLevel?: import('../pi-sessions.js').ThinkingLevel }) {
    this.assertAvailable(id);
    return this.runs.reviseAndStart(id, input);
  }

  async updateSettings(patch: SettingsPatch) {
    this.assertAvailable();
    const next = mergeSettings(this.settings, patch);
    this.pi.resolveModel(next.model);
    this.delegation.validate(next.subagents);
    const commit = () => {
      writeJson(this.paths.settings, next);
      this.settings = next;
      this.delegation.configure();
    };
    this.configuring = this.plugins.configure(next, commit, () => {
      if (this.hasActiveWork) throw new Error('Stop active conversations before changing tools or Skills');
    });
    try { if (this.configuring) await this.configuring; }
    finally {
      this.configuring = undefined;
      this.pi.reconcileResources();
    }
    return next;
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled([this.configuring, this.runs.stop(), ...this.pi.pending]);
    this.pi.close();
    await this.plugins.close();
    await this.pi.models?.settleCredentialWrites();
  }
}
