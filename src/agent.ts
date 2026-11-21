import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader
} from '@earendil-works/pi-coding-agent';
import { PluginHost } from './plugins.js';
import { SessionRegistry } from './registry.js';
import { readSettings, writeJson } from './config.js';

export class MinihRuntime {
  paths: ReturnType<typeof import('./config.js').getPaths>;
  settings: import('./config.js').Settings;
  registry: SessionRegistry;
  openSessions: Map<string, any>;
  busy: Set<string>;
  plugins: PluginHost;
  models!: ModelRuntime;
  constructor(paths: ReturnType<typeof import('./config.js').getPaths>) {
    this.paths = paths;
    this.settings = readSettings(paths);
    this.registry = new SessionRegistry(paths);
    this.openSessions = new Map();
    this.busy = new Set();
    this.plugins = new PluginHost(this);
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
    if (choice?.provider && choice?.id) {
      const model = this.models.getModel(choice.provider, choice.id);
      if (!model) throw new Error('Unknown model: ' + choice.provider + '/' + choice.id);
      return model;
    }
    return undefined;
  }

  async open(id: string, { child = false, modelChoice }: {child?:boolean;modelChoice?:{provider:string;id:string}} = {}) {
    if (this.openSessions.has(id)) return this.openSessions.get(id);
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
    const customTools = this.plugins.getTools({ child, id });
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
      content: m.content,
      timestamp: m.timestamp
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
    try {
      const session = await this.open(id, { child, modelChoice: choice });
      if (choice && choice.provider && choice.id) {
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
        signal.addEventListener('abort', () => { void session.abort(); }, { once: true });
      }
      await session.prompt(prompt);
      if (session.sessionFile) this.registry.update(id, { file: session.sessionFile });
      if (record.title === 'New conversation') this.registry.update(id, { title: prompt.trim().slice(0, 72) });
      const answer = session.getLastAssistantText() || '';
      emit({ type: 'complete', text: answer });
      return answer;
    } finally {
      off();
      this.busy.delete(id);
    }
  }

  async runChild(parentId: string, task: string, chosen: {provider:string;id:string}, signal?:AbortSignal) {
    const parent = this.registry.get(parentId);
    const record = this.registry.create({
      parentId, cwd: parent.cwd,
      title: task.slice(0, 72)
    });
    try {
      const text = await this.send(record.id, task, () => {}, { signal, child: true, choice: chosen.id ? chosen : undefined });
      return { id: record.id, text };
    } catch (error) {
      this.registry.update(record.id, { title: '[Failed] ' + task.slice(0, 62) });
      throw error;
    }
  }

  async delete(ids: string[]) {
    const all = this.registry.descendants(ids);
    if (all.some((id) => this.busy.has(id))) throw new Error('Stop active conversations before deleting them');
    for (const id of all) {
      const session = this.openSessions.get(id);
      if (session) { session.dispose(); this.openSessions.delete(id); }
    }
    return this.registry.delete(ids);
  }

  async updateSettings(patch: Partial<import('./config.js').Settings>, mergeSettings: typeof import('./config.js').mergeSettings) {
    const next = mergeSettings(this.settings, patch);
    if (this.busy.size) throw new Error('Cannot change settings during an active run');
    for (const session of this.openSessions.values()) session.dispose();
    this.openSessions.clear();
    await this.plugins.close();
    this.settings = next;
    this.plugins = new PluginHost(this);
    await this.plugins.activate();
    writeJson(this.paths.settings, next);
    return next;
  }

  async stop() {
    for (const session of this.openSessions.values()) session.dispose();
    this.openSessions.clear();
    await this.plugins.close();
  }
}
