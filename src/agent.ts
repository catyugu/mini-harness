import { isDeepStrictEqual } from 'node:util';
import { PluginHost } from './plugins.js';
import { SessionRegistry, type ModelChoice } from './registry.js';
import { mergeSettings, readSettings, writeJson, type Paths, type SettingsPatch } from './config.js';
import { requireChildDepth, Semaphore } from './subagents.js';
import { PiSessions } from './pi-sessions.js';
import { Runs } from './runs.js';

export class MiniHarnessRuntime {
  settings: ReturnType<typeof readSettings>;
  readonly registry: SessionRegistry;
  readonly plugins: PluginHost;
  readonly pi: PiSessions;
  readonly runs: Runs;
  readonly semaphore: Semaphore;
  private readonly waitingApprovals = new Map<string, number>();
  private configuring?: Promise<void>;
  private readonly deleting = new Set<string>();
  private stopping = false;

  constructor(readonly paths: Paths) {
    this.settings = readSettings(paths);
    this.registry = new SessionRegistry(paths);
    this.semaphore = new Semaphore(this.settings.subagents.maxParallel);
    this.plugins = new PluginHost({
      paths, settings: () => this.settings, models: { list: () => this.pi.availableModels() },
      sessions: {
        get: (id) => structuredClone(this.registry.get(id)),
        list: () => structuredClone(this.registry.list())
      },
      workspaces: {
        resolve: (id) => this.workspacePath(id),
        approval: (id, waiting) => {
          const count = this.waitingApprovals.get(id) ?? 0;
          const next = count + (waiting ? 1 : -1);
          if (next > 0) this.waitingApprovals.set(id, next);
          else this.waitingApprovals.delete(id);
          if (Boolean(count) !== (next > 0)) this.registry.notify(id);
        }
      },
      delegation: this.delegation
    });
    this.pi = new PiSessions(paths, this.registry, this.plugins, () => this.settings.model,
      (model) => this.rememberModel(model), (id) => this.assertAvailable(id), (id) => this.runs.active(id));
    this.runs = new Runs(this.registry, this.pi, () => this.settings.model, (id) => this.assertAvailable(id),
      (task, signal) => this.semaphore.run(task, signal));
  }

  workspacePath(id: string) {
    const item = this.registry.get(id);
    if (!item) throw new Error('Conversation not found');
    return this.registry.workspaces.resolveRoot(item.cwd, item.workspaceId);
  }

  navigationSession(id: string) {
    const record = this.registry.get(id);
    return record && { ...record, waitingApproval: this.waitingApprovals.has(id) };
  }

  async start() {
    await this.pi.start();
    await this.plugins.configure(this.settings);
  }

  get hasActiveWork() { return this.runs.hasWork || this.pi.hasPending; }

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
    return { ...this.registry.get(id), messages: this.pi.messages(id), model: this.pi.modelInfo(session.model),
      selectedModel: { ...this.settings.model }, thinkingLevel: session.thinkingLevel, ...this.runs.view(id),
      queue: this.pi.queue(session) };
  }

  readonly delegation = {
    depth: (id: string) => this.registry.depth(id),
    parentModel: (id: string) => this.pi.activeModel(id),
    run: (id: string, task: string, choice: ModelChoice, signal?: AbortSignal) =>
      this.runs.delegate(id, signal, (cancellation) => this.runChild(id, task, choice, cancellation))
  };

  async runChild(parentId: string, task: string, choice: ModelChoice, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const parent = this.registry.get(parentId);
    if (!parent) throw new Error('Parent conversation not found');
    this.assertAvailable(parentId);
    requireChildDepth(this.registry.depth(parentId), this.settings.subagents.maxDepth);
    const model = this.pi.resolveModel(choice);
    const record = this.registry.create({
      parentId, workspaceId: parent.workspaceId, title: task.slice(0, 72), model: model && this.pi.modelInfo(model)
    });
    try {
      const text = await this.runs.send(record.id, task, undefined, { signal });
      return { id: record.id, text };
    } catch (error) {
      if (this.registry.get(record.id)) this.registry.update(record.id, {
        title: (signal?.aborted || this.runs.info(record.id)?.state === 'cancelled' ? '[Cancelled] ' : '[Failed] ') + task.slice(0, 60)
      });
      throw error;
    }
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

  async updateSettings(patch: SettingsPatch) {
    this.assertAvailable();
    const next = mergeSettings(this.settings, patch);
    this.pi.resolveModel(next.model);
    if (next.subagents.provider) this.pi.resolveModel({ provider: next.subagents.provider, id: next.subagents.model });
    const toolsChanged = this.plugins.needsUpdate(next);
    const previousDepth = this.settings.subagents.maxDepth;
    const depthChanged = next.subagents.maxDepth !== previousDepth;
    if (!toolsChanged) {
      writeJson(this.paths.settings, next);
      this.settings = next;
      this.semaphore.setLimit(next.subagents.maxParallel);
      if (depthChanged) for (const id of this.pi.ids) {
        const depth = this.registry.depth(id);
        if ((depth < previousDepth) !== (depth < next.subagents.maxDepth)) this.pi.markStale(id);
      }
      return next;
    }
    if (this.hasActiveWork)
      throw new Error('Stop active conversations before changing tools or Skills');
    const resources = new Map([...this.pi.ids].map((id) => [id, this.plugins.resources(id)]));
    this.configuring = this.plugins.configure(next, () => writeJson(this.paths.settings, next));
    try {
      await this.configuring;
      this.settings = next;
      this.semaphore.setLimit(next.subagents.maxParallel);
      return next;
    } finally {
      // A rollback can replace closures too. Keep sessions whose actual resources survived.
      for (const [id, before] of resources) {
        const after = this.plugins.resources(id);
        if (before.length !== after.length || before.some((resource, i) => resource !== after[i])) {
          this.pi.release(id);
        }
      }
      this.configuring = undefined;
    }
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled([this.configuring, this.runs.stop(), ...this.pi.pending]);
    this.pi.close();
    await this.plugins.close();
    await this.pi.models?.settleCredentialWrites();
  }
}
