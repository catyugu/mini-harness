import type { ConversationPort, SessionStore, AgentPort, RunPort, SettingsPort } from '../contracts/services.js';

export class ConversationOperations implements ConversationPort {
  private readonly deleting = new Set<string>();
  private readonly deletingWorkspaces = new Set<string>();
  private stopping = false;

  constructor(readonly registry: SessionStore, readonly pi: AgentPort, readonly runs: RunPort,
    private readonly settings: SettingsPort) {}

  get hasActiveWork() { return this.runs.size > 0 || this.pi.hasPending; }

  assertAvailable(id?: string) {
    if (this.settings.changing || this.stopping) throw new Error('Agent service is unavailable during reconfiguration or shutdown');
    if (id && this.deleting.has(id)) throw new Error('Conversation is being deleted');
    if (id && this.deletingWorkspaces.has(this.registry.get(id)?.workspaceId ?? ''))
      throw new Error('Workspace is being deleted');
  }

  createConversation(input: { workspaceId?: string } = {}) {
    this.assertAvailable();
    const workspaceId = input.workspaceId ?? this.registry.workspaces.defaultId;
    if (!workspaceId || this.deletingWorkspaces.has(workspaceId)) throw new Error('Workspace is being deleted or not available');
    return this.registry.create({ workspaceId });
  }

  async deleteWorkspace(id: string) {
    this.assertAvailable();
    this.registry.workspaces.get(id);
    if (this.deletingWorkspaces.has(id)) throw new Error('Workspace is being deleted');
    this.deletingWorkspaces.add(id);
    try {
      const ids = this.registry.list(id).map(({ id }) => id);
      const deleted = await this.delete(ids);
      this.registry.workspaces.remove(id);
      return { removed: id, deleted };
    } finally { this.deletingWorkspaces.delete(id); }
  }

  async getConversation(id: string) {
    const session = await this.pi.open(id);
    return { ...this.registry.get(id), messages: this.pi.messages(id), leafId: session.sessionManager.getLeafId(), model: this.pi.modelInfo(session.model),
      selectedModel: { ...this.settings.settings.model }, thinkingLevel: session.thinkingLevel, ...this.runs.view(id),
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
      for (const id of all) this.runs.cancel(id);
      await Promise.allSettled(all.flatMap((id) => [this.runs.completion(id), this.pi.openingSession(id)]));
      for (const id of all) this.pi.release(id);
      return this.registry.delete(ids);
    } finally { for (const id of all) this.deleting.delete(id); }
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled([this.runs.stop(), ...this.pi.pending]);
    this.pi.close();
  }
}
