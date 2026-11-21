import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession, defineTool, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader,
  type AgentSession
} from '@earendil-works/pi-coding-agent';
import { PluginHost } from './plugins.js';
import { SessionRegistry } from './registry.js';
import { mergeSettings, readSettings, writeJson, type SettingsPatch } from './config.js';
import { Type } from 'typebox';
import { requireChildDepth, selectChildModel, Semaphore } from './subagents.js';

export class MiniHarnessRuntime {
  paths: ReturnType<typeof import('./config.js').getPaths>;
  settings: import('./config.js').Settings;
  registry: SessionRegistry;
  openSessions: Map<string, AgentSession>;
  openingSessions: Map<string, Promise<AgentSession>>;
  busy: Set<string>;
  plugins: PluginHost;
  models!: ModelRuntime;
  readonly semaphore: Semaphore;
  private updating = false;
  private stopping = false;
  constructor(paths: ReturnType<typeof import('./config.js').getPaths>) {
    this.paths = paths;
    this.settings = readSettings(paths);
    this.registry = new SessionRegistry(paths);
    this.openSessions = new Map();
    this.openingSessions = new Map();
    this.busy = new Set();
    this.semaphore = new Semaphore(this.settings.subagents.maxParallel);
    this.plugins = new PluginHost(this, this.settings);
  }

  async start() {
    this.models = await ModelRuntime.create({
      authPath: join(this.paths.home, 'auth.json'),
      modelsPath: join(this.paths.home, 'models.json'),
      refreshOnCreate: false
    });
    await this.plugins.activate();
  }

  modelInfo(model: any) {
    return { provider: model?.provider ?? '', id: model?.id ?? '' };
  }

  availableModels() {
    return this.models.getModels().map((m) => ({
      provider: m.provider, id: m.id, name: m.name || m.id,
      configured: this.models.getProviderAuthStatus(m.provider).configured
    }));
  }

  resolveModel(choice: {provider:string;id:string} = this.settings.model) {
    if (!choice?.provider) {
      if (choice?.id) throw new Error('A model ID requires a provider');
      return undefined;
    }
    // A provider-only override selects one of its available models.
    const id = choice.id || this.models.getAvailableSnapshot().find((m) => m.provider === choice.provider)?.id ||
      this.models.getModels(choice.provider)[0]?.id;
    if (!id) throw new Error('No model is available for provider: ' + choice.provider);
    const model = this.models.getModel(choice.provider, id);
    if (!model) throw new Error('Unknown model: ' + choice.provider + '/' + id);
    return model;
  }

  async open(id: string, options: {child?:boolean;modelChoice?:{provider:string;id:string}} = {}): Promise<AgentSession> {
    if (this.updating || this.stopping) throw new Error('Agent service is unavailable during reconfiguration or shutdown');
    const active = this.openSessions.get(id);
    if (active) return active;
    const pending = this.openingSessions.get(id);
    if (pending) return pending;
    const opening = this.openNewSession(id, options);
    this.openingSessions.set(id, opening);
    try { return await opening; }
    finally { this.openingSessions.delete(id); }
  }

  private async openNewSession(id: string, { child = false, modelChoice }: {child?:boolean;modelChoice?:{provider:string;id:string}} = {}): Promise<AgentSession> {
    const item = this.registry.get(id);
    if (!item) throw new Error('Conversation not found');
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: item.cwd,
      agentDir: this.paths.agent,
      settingsManager,
      additionalSkillPaths: this.settings.plugins.skills ? [this.paths.skills, this.paths.projectSkills] : [],
      noSkills: !this.settings.plugins.skills,
      noExtensions: true
    });
    await loader.reload();
    const manager = item.file && existsSync(item.file)
      ? SessionManager.open(item.file, this.paths.sessions, item.cwd)
      : SessionManager.create(item.cwd, this.paths.sessions);
    const customTools = this.plugins.getTools(id);
    const { session } = await createAgentSession({
      cwd: item.cwd,
      agentDir: this.paths.agent,
      modelRuntime: this.models,
      model: this.resolveModel(modelChoice),
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      tools: ['read', 'edit', 'write', 'grep', 'find', 'ls', ...customTools.map((tool) => tool.name)],
      customTools
    });
    this.openSessions.set(id, session);
    return session;
  }

  sessionMessages(id: string) {
    const session = this.openSessions.get(id);
    if (!session) return [];
    return session.messages.map((m) => ({
      role: m.role,
      content: 'content' in m ? m.content : [],
      timestamp: 'timestamp' in m ? m.timestamp : undefined
    }));
  }

  async getConversation(id: string) {
    const item = this.registry.get(id);
    if (!item) throw new Error('Conversation not found');
    const session = await this.open(id, { child: Boolean(item.parentId) });
    return { ...item, messages: this.sessionMessages(id), model: this.modelInfo(session.model), busy: this.busy.has(id) };
  }

  async send(id: string, prompt: string, emit: (event:any) => void = () => {}, { signal, child = false, choice }: {signal?:AbortSignal;child?:boolean;choice?:{provider:string;id:string}} = {}) {
    if (this.busy.has(id)) throw new Error('Conversation is already running');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw new Error('Invalid message');
    this.busy.add(id);
    let off = () => {};
    let cancel: (() => void) | undefined;
    try {
      const session = await this.open(id, { child, modelChoice: choice });
      if (choice?.provider) {
        const model = this.resolveModel(choice);
        await session.setModel(model);
      }
      const record = this.registry.get(id);
      off = session.subscribe((event) => {
        if (event.type === 'message_update' &&
            event.assistantMessageEvent?.type === 'text_delta') {
          emit({ type: 'delta', text: event.assistantMessageEvent.delta });
        }
        if (event.type === 'tool_execution_start') emit({ type: 'tool', name: event.toolName });
      });
      if (signal) {
        if (signal.aborted) throw new Error('Aborted');
        cancel = () => { void session.abort(); };
        signal.addEventListener('abort', cancel, { once: true });
      }
      await session.prompt(prompt);
      if (signal?.aborted) throw new Error('Agent run cancelled');
      if (session.sessionFile) this.registry.update(id, { file: session.sessionFile });
      if (record.title === 'New conversation') this.registry.update(id, { title: prompt.trim().slice(0, 72) });
      const answer = session.getLastAssistantText() || '';
      emit({ type: 'complete', text: answer });
      return answer;
    } finally {
      if (cancel) signal?.removeEventListener('abort', cancel);
      off();
      this.busy.delete(id);
    }
  }

  canDelegate(id: string) {
    const record = this.registry.get(id);
    return Boolean(record && !record.parentId);
  }

  delegateTool(id?: string) {
    return defineTool({
      name: 'delegate',
      label: 'Delegate',
      description: 'Create a child agent for a specific task. Set provider/model to override the default.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 12000 }),
        provider: Type.Optional(Type.String()),
        model: Type.Optional(Type.String())
      }),
      execute: async (_callId, args, signal) => {
        const parent = this.openSessions.get(id);
        if (!parent) throw new Error('Parent session not open');
        const chosen = selectChildModel(args, this.settings.subagents, this.modelInfo(parent.model));
        const result = await this.semaphore.run(() => this.runChild(id, args.task, chosen, signal), signal);
        return { content: [{ type: 'text', text: result.text }], details: { sessionId: result.id } };
      }
    });
  }

  async runChild(parentId: string, task: string, chosen: {provider:string;id:string}, signal?:AbortSignal) {
    const parent = this.registry.get(parentId);
    if (!parent) throw new Error('Parent conversation not found');
    requireChildDepth(parent.parentId ? 1 : 0);
    const record = this.registry.create({
      parentId, cwd: parent.cwd,
      title: task.slice(0, 72)
    });
    try {
      const text = await this.send(record.id, task, () => {}, { signal, child: true, choice: chosen.provider ? chosen : undefined });
      return { id: record.id, text };
    } catch (error) {
      this.registry.update(record.id, { title: '[Failed] ' + task.slice(0, 62) });
      throw error;
    }
  }

  async delete(ids: string[]) {
    const all = this.registry.descendants(ids);
    if (all.some((id) => this.busy.has(id) || this.openingSessions.has(id)))
      throw new Error('Stop active conversations before deleting them');
    for (const id of all) {
      const session = this.openSessions.get(id);
      if (session) { session.dispose(); this.openSessions.delete(id); }
    }
    return this.registry.delete(ids);
  }

  async updateSettings(patch: SettingsPatch) {
    if (this.updating || this.stopping || this.busy.size || this.openingSessions.size)
      throw new Error('Cannot change settings while the agent service is busy');
    const next = mergeSettings(this.settings, patch);
    this.resolveModel(next.model);
    this.updating = true;
    const replacePlugins = JSON.stringify(next.plugins) !== JSON.stringify(this.settings.plugins) ||
      JSON.stringify(next.pluginConfig) !== JSON.stringify(this.settings.pluginConfig);
    const candidate = replacePlugins ? new PluginHost(this, next) : undefined;
    try {
      await candidate?.activate();
      writeJson(this.paths.settings, next);
      for (const session of this.openSessions.values()) session.dispose();
      this.openSessions.clear();
      const previous = this.plugins;
      this.settings = next;
      this.semaphore.setLimit(next.subagents.maxParallel);
      if (candidate) {
        this.plugins = candidate;
        await previous.close();
      }
      return next;
    } catch (error) {
      if (candidate && candidate !== this.plugins) await candidate.close();
      throw error;
    } finally {
      this.updating = false;
    }
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled(this.openingSessions.values());
    for (const session of this.openSessions.values()) session.dispose();
    this.openSessions.clear();
    await this.plugins.close();
  }
}
