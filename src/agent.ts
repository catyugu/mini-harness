import { join } from 'node:path';
import {
  createAgentSession, defineTool, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader,
  type AgentSession
} from '@earendil-works/pi-coding-agent';
import { PluginHost } from './plugins.js';
import { SessionRegistry, type ModelChoice } from './registry.js';
import { mergeSettings, readSettings, writeJson, type SettingsPatch } from './config.js';
import { Type } from 'typebox';
import { Workspace } from './workspace.js';
import type { ViewMessage, StreamEvent } from './protocol.js';
import { requireChildDepth, selectChildModel, Semaphore, type ChildLease } from './subagents.js';

interface ActiveRun {
  controller: AbortController;
  done?: Promise<string>;
  lease?: ChildLease;
}

export class MiniHarnessRuntime {
  paths: ReturnType<typeof import('./config.js').getPaths>;
  settings: import('./config.js').Settings;
  registry: SessionRegistry;
  openSessions: Map<string, AgentSession>;
  openingSessions: Map<string, Promise<AgentSession>>;
  readonly busy = new Map<string, ActiveRun>();
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

  async open(id: string): Promise<AgentSession> {
    if (this.updating || this.stopping) throw new Error('Agent service is unavailable during reconfiguration or shutdown');
    const active = this.openSessions.get(id);
    if (active) return active;
    const pending = this.openingSessions.get(id);
    if (pending) return pending;
    const opening = this.openNewSession(id);
    this.openingSessions.set(id, opening);
    try { return await opening; }
    finally { this.openingSessions.delete(id); }
  }

  private async openNewSession(id: string): Promise<AgentSession> {
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
    const file = this.registry.checkedFile(item);
    const manager = file ? SessionManager.open(file, this.paths.sessions, item.cwd) :
      SessionManager.create(item.cwd, this.paths.sessions, { id: item.id });
    if (item.file !== manager.getSessionFile()) this.registry.update(id, { file: manager.getSessionFile() });
    const customTools = [...new Workspace(item.cwd, this.paths.home).tools(), ...this.plugins.getTools(id)];
    const { session } = await createAgentSession({
      cwd: item.cwd,
      agentDir: this.paths.agent,
      modelRuntime: this.models,
      model: this.resolveModel(item.model),
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      tools: customTools.map((tool) => tool.name),
      customTools
    });
    if (item.model && (session.model?.provider !== item.model.provider || session.model?.id !== item.model.id)) {
      try { await session.setModel(this.resolveModel(item.model)); }
      catch (error) { session.dispose(); throw error; }
    }
    this.openSessions.set(id, session);
    return session;
  }

  sessionMessages(id: string): ViewMessage[] {
    const session = this.openSessions.get(id);
    if (!session) return [];
    return session.messages.flatMap<ViewMessage>((message) => {
      switch (message.role) {
        case 'user':
        case 'assistant':
          return [{
            role: message.role, content: message.content, timestamp: message.timestamp,
            error: message.role === 'assistant' ? message.errorMessage : undefined
          }];
        case 'toolResult':
          return [{
            role: message.role, content: message.content, timestamp: message.timestamp,
            toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError,
            sessionId: message.details && typeof message.details === 'object' && 'sessionId' in message.details &&
              typeof message.details.sessionId === 'string' ? message.details.sessionId : undefined
          }];
        default: return [];
      }
    });
  }

  async getConversation(id: string) {
    if (!this.registry.get(id)) throw new Error('Conversation not found');
    const session = await this.open(id);
    return { ...this.registry.get(id), messages: this.sessionMessages(id), model: this.modelInfo(session.model), busy: this.busy.has(id) };
  }

  async send(id: string, prompt: string, emit: (event: StreamEvent) => void = () => {}, { signal }: { signal?: AbortSignal } = {}) {
    if (this.updating || this.stopping) throw new Error('Agent service is unavailable during reconfiguration or shutdown');
    if (this.busy.has(id)) throw new Error('Conversation is already running');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000) throw new Error('Invalid message');
    const record = this.registry.get(id);
    if (!record) throw new Error('Conversation not found');
    const run: ActiveRun = { controller: new AbortController() };
    const cancellation = signal ? AbortSignal.any([run.controller.signal, signal]) : run.controller.signal;
    this.busy.set(id, run);
    const promptSession = () => this.runPrompt(record, prompt, emit, cancellation);
    run.done = record.parentId ? this.semaphore.run((lease) => {
      run.lease = lease;
      return promptSession();
    }, cancellation) : promptSession();
    try { return await run.done; }
    finally { this.busy.delete(id); }
  }

  cancel(id: string) {
    const run = this.busy.get(id);
    run?.controller.abort(new Error('Agent run cancelled'));
    return Boolean(run);
  }

  private async runPrompt(record: NonNullable<ReturnType<SessionRegistry['get']>>, prompt: string,
      emit: (event: StreamEvent) => void, signal: AbortSignal) {
    const { id } = record;
    signal.throwIfAborted();
    const session = await this.open(id);
    signal.throwIfAborted();
    if (record.title === 'New conversation') this.registry.update(id, { title: prompt.trim().slice(0, 72) });
    const off = session.subscribe((event) => {
      switch (event.type) {
        case 'message_start':
          if (event.message.role === 'assistant') emit({ type: 'assistant-start' });
          break;
        case 'message_update':
          if (event.assistantMessageEvent?.type === 'text_delta')
            emit({ type: 'delta', text: event.assistantMessageEvent.delta });
          break;
        case 'tool_execution_start':
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: 'running' });
          break;
        case 'tool_execution_update':
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: 'running', content: event.partialResult?.content });
          break;
        case 'tool_execution_end':
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: event.isError ? 'error' : 'finished',
            content: event.result?.content, sessionId: event.result?.details?.sessionId });
          break;
      }
    });
    const cancel = () => { void session.abort().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await session.prompt(prompt);
      signal.throwIfAborted();
      const last = session.messages.at(-1);
      if (last?.role === 'assistant' && last.errorMessage) throw new Error(last.errorMessage);
      const answer = session.getLastAssistantText() || '';
      emit({ type: 'complete', text: answer });
      return answer;
    } finally {
      signal.removeEventListener('abort', cancel);
      off();
      if (session.sessionFile && session.sessionFile !== this.registry.get(id)?.file) {
        this.registry.checkedFile({ cwd: record.cwd, file: session.sessionFile });
        this.registry.update(id, { file: session.sessionFile });
      }
    }
  }

  canDelegate(id: string) {
    return this.registry.depth(id) < this.settings.subagents.maxDepth;
  }

  delegateTool(id?: string) {
    return defineTool({
      name: 'delegate',
      label: 'Delegate',
      description: 'Create a child agent for a specific task. Set provider/model to override the default.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 12000 }),
        provider: Type.Optional(Type.String({ maxLength: 160 })),
        model: Type.Optional(Type.String({ maxLength: 160 }))
      }),
      execute: async (_callId, args, signal) => {
        const parent = this.openSessions.get(id);
        if (!parent) throw new Error('Parent session not open');
        const run = this.busy.get(id);
        const cancellation = run && signal ? AbortSignal.any([run.controller.signal, signal]) : signal ?? run?.controller.signal;
        const chosen = selectChildModel(args, this.settings.subagents, this.modelInfo(parent.model));
        const delegate = () => this.runChild(id, args.task, chosen, cancellation);
        // A child waiting for its own delegate yields its slot. This also works with maxParallel=1.
        const result = run?.lease ? await run.lease.pause(delegate) : await delegate();
        return { content: [{ type: 'text', text: result.text }], details: { sessionId: result.id } };
      }
    });
  }

  async runChild(parentId: string, task: string, choice: ModelChoice, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const parent = this.registry.get(parentId);
    if (!parent) throw new Error('Parent conversation not found');
    requireChildDepth(this.registry.depth(parentId), this.settings.subagents.maxDepth);
    const model = this.resolveModel(choice);
    const record = this.registry.create({
      parentId, cwd: parent.cwd, title: task.slice(0, 72), model: model && this.modelInfo(model)
    });
    try {
      const text = await this.send(record.id, task, undefined, { signal });
      return { id: record.id, text };
    } catch (error) {
      this.registry.update(record.id, { title: (signal?.aborted ? '[Cancelled] ' : '[Failed] ') + task.slice(0, 60) });
      throw error;
    }
  }

  export(ids: string[]) {
    const all = this.registry.descendants(ids);
    if (all.some((id) => this.busy.has(id) || this.openingSessions.has(id)))
      throw new Error('Stop active conversations before exporting them');
    return this.registry.export(ids);
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
    if (next.subagents.provider) this.resolveModel({ provider: next.subagents.provider, id: next.subagents.model });
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
    for (const id of this.busy.keys()) this.cancel(id);
    await Promise.allSettled([...this.openingSessions.values(), ...[...this.busy.values()].map(({ done }) => done)]);
    for (const session of this.openSessions.values()) session.dispose();
    this.openSessions.clear();
    await this.plugins.close();
  }
}
