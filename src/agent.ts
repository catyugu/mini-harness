import { Approvals } from './approvals.js';
import { prepareInput, type Attachment, type ImageInput } from './input.js';
import { join, relative, resolve, sep }  from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  createAgentSession, defineTool, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader,
  type AgentSession
} from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { PluginHost } from './plugins.js';
import { SessionRegistry, type ModelChoice } from './registry.js';
import { mergeSettings, readSettings, writeJson, type SettingsPatch } from './config.js';
import { Type } from 'typebox';
import { isRunning, type ViewMessage, type StreamEvent, type RunEvent, type RunInfo } from './protocol.js';
import { requireChildDepth, selectChildModel, Semaphore, type ChildLease } from './subagents.js';

interface ActiveRun {
  info: RunInfo;
  controller: AbortController;
  events: RunEvent[];
  bytes: number;
  partial: string;
  tools: Map<string, Extract<StreamEvent, { type: 'tool' }>>;
  listeners: Set<(event: RunEvent) => void>;
  done?: Promise<string>;
  lease?: ChildLease;
}

export class MiniHarnessRuntime {
  paths: ReturnType<typeof import('./config.js').getPaths>;
  settings: import('./config.js').Settings;
  registry: SessionRegistry;
  openSessions: Map<string, AgentSession>;
  openingSessions: Map<string, Promise<AgentSession>>;
  readonly approvals = new Approvals();
  readonly busy = new Map<string, ActiveRun>();
  readonly plugins: PluginHost;
  models!: ModelRuntime;
  readonly semaphore: Semaphore;
  private configuring?: Promise<void>;
  private readonly staleSessions = new Set<string>();
  private readonly compactions = new Map<string, { done: Promise<void>; controller: AbortController }>();
  private readonly deleting = new Set<string>();
  private stopping = false;
  constructor(paths: ReturnType<typeof import('./config.js').getPaths>) {
    this.paths = paths;
    this.settings = readSettings(paths);
    this.registry = new SessionRegistry(paths);
    this.openSessions = new Map();
    this.openingSessions = new Map();
    this.semaphore = new Semaphore(this.settings.subagents.maxParallel);
    this.plugins = new PluginHost(this);
  }

  async start() {
    this.models = await ModelRuntime.create({
      authPath: join(this.paths.home, 'auth.json'),
      modelsPath: join(this.paths.home, 'models.json'),
      refreshOnCreate: false
    });
    await this.models.getAvailable();
    await this.plugins.configure(this.settings);
  }

  modelInfo(model: AgentSession['model']) {
    return { provider: model?.provider ?? '', id: model?.id ?? '' };
  }

  availableModels() {
    const available = new Set(this.models.getAvailableSnapshot().map(({ provider, id }) => JSON.stringify([provider, id])));
    return this.models.getModels().map((model) => ({
      provider: model.provider, id: model.id, name: model.name || model.id,
      configured: available.has(JSON.stringify([model.provider, model.id])), thinkingLevels: getSupportedThinkingLevels(model)
    }));
  }

  resolveModel(choice: ModelChoice = this.settings.model) {
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

  get hasActiveWork() { return Boolean(this.busy.size || this.openingSessions.size || this.compactions.size); }

  async open(id: string): Promise<AgentSession> {
    if (this.configuring || this.stopping) throw new Error('Agent service is unavailable during reconfiguration or shutdown');
    if (this.deleting.has(id)) throw new Error('Conversation is being deleted');
    const active = this.openSessions.get(id);
    if (active && (!this.staleSessions.has(id) || this.busy.has(id) || this.compactions.has(id))) return active;
    if (active) { active.dispose(); this.openSessions.delete(id); this.staleSessions.delete(id); }
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
      additionalSkillPaths: this.plugins.ctx.harnessSkills?.paths ?? [],
      noSkills: !this.plugins.ctx.harnessSkills,
      noExtensions: true
    });
    await loader.reload();
    const file = this.registry.checkedFile(item);
    const manager = file ? SessionManager.open(file, this.paths.sessions, item.cwd) :
      SessionManager.create(item.cwd, this.paths.sessions, { id: item.id });
    if (item.file !== manager.getSessionFile()) this.registry.update(id, { file: manager.getSessionFile() });
    const customTools = this.plugins.getTools(id);
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
    const argumentsById = new Map<string, unknown>();
    for (const message of session.messages) if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'toolCall') argumentsById.set(block.id, block.arguments);
    }
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
            arguments: argumentsById.get(message.toolCallId), toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError,
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
    return { ...this.registry.get(id), messages: this.sessionMessages(id), model: this.modelInfo(session.model),
      selectedModel: { ...this.settings.model }, thinkingLevel: session.thinkingLevel,
      run: this.runInfo(id), partial: this.busy.get(id)?.partial, tools: [...this.busy.get(id)?.tools.values() ?? []], busy: this.busy.has(id), queue: { steer: session.getSteeringMessages(), followUp: session.getFollowUpMessages() } };
  }

  private launch(id: string, prompt: string, emit: (event: StreamEvent) => void, { signal, model, attachments, thinkingLevel }: { signal?: AbortSignal; model?: ModelChoice; attachments?: Attachment[]; thinkingLevel?: AgentSession['thinkingLevel'] } = {}) {
    if (this.configuring || this.stopping) throw new Error('Agent service is unavailable during reconfiguration or shutdown');
    if (this.busy.has(id) || this.compactions.has(id)) throw new Error('Conversation is already running');
    if (this.deleting.has(id)) throw new Error('Conversation is being deleted');
    if (thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinkingLevel))
      throw new Error('Invalid thinking level');
    const prepared = prepareInput(prompt, attachments);
    prompt = prepared.text;
    const record = this.registry.get(id);
    if (!record) throw new Error('Conversation not found');
    if (model !== undefined) {
      if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string' ||
          model.provider.length > 160 || model.id.length > 160) throw new Error('Invalid model choice');
      this.resolveModel(model);
    }
    const choice = model ?? (record.parentId ? record.model : this.settings.model);
    if (this.staleSessions.delete(id)) {
      this.openSessions.get(id)?.dispose();
      this.openSessions.delete(id);
    }
    const run: ActiveRun = {
      info: { id: randomUUID(), sessionId: id, state: 'queued', startedAt: new Date().toISOString(), sequence: 0 },
      controller: new AbortController(), events: [], bytes: 0, partial: '', tools: new Map(), listeners: new Set()
    };
    const cancellation = signal ? AbortSignal.any([run.controller.signal, signal]) : run.controller.signal;
    this.registry.update(id, { run: run.info });
    this.busy.set(id, run);
    const publish = (event: StreamEvent) => {
      if (event.type === 'assistant-start' || event.type === 'assistant-end') run.partial = '';
      if (event.type === 'delta') run.partial += event.text;
      if (event.type === 'tool') {
        if (event.state === 'running') run.tools.set(event.id, event);
        else run.tools.delete(event.id);
      }
      const item = { ...event, sequence: ++run.info.sequence };
      run.events.push(item);
      run.bytes += JSON.stringify(item).length;
      while (run.events.length > 2048 || (run.bytes > 1024 * 1024 && run.events.length > 1))
        run.bytes -= JSON.stringify(run.events.shift()).length;
      for (const listener of run.listeners) {
        try { listener(structuredClone(item)); } catch { run.listeners.delete(listener); }
      }
      try { emit?.(item); } catch { /* An observer cannot terminate the run. */ }
    };
    const promptSession = async () => {
      cancellation.throwIfAborted();
      run.info.state = 'running';
      this.registry.update(id, { run: run.info });
      publish({ type: 'run', run: { ...run.info } });
      return this.runPrompt(record, prompt, publish, cancellation, choice, prepared.images, thinkingLevel);
    };
    const work = record.parentId ? this.semaphore.run((lease) => {
      run.lease = lease;
      return promptSession();
    }, cancellation) : promptSession();
    run.done = work.then((text) => {
      run.info.state = 'completed';
      return text;
    }, (error) => {
      run.info.state = cancellation.aborted ? 'cancelled' : 'failed';
      run.info.error = cancellation.aborted ? 'Agent run cancelled' : error instanceof Error ? error.message : String(error);
      publish({ type: 'error', error: run.info.error });
      throw new Error(run.info.error, { cause: error });
    }).finally(() => {
      run.info.finishedAt = new Date().toISOString();
      publish({ type: 'run', run: { ...run.info } });
      try { this.registry.update(id, { run: run.info }); }
      finally { this.busy.delete(id); run.listeners.clear(); }
    });
    // Server-owned runs may outlive every observer.
    void run.done.catch(() => {});
    return run;
  }

  async send(id: string, prompt: string, emit: (event: StreamEvent) => void = () => {}, options: { signal?: AbortSignal; model?: ModelChoice; attachments?: Attachment[] } = {}) {
    return this.launch(id, prompt, emit, options).done;
  }

  startRun(id: string, prompt: string, model?: ModelChoice, attachments?: Attachment[], thinkingLevel?: AgentSession['thinkingLevel']) {
    return { ...this.launch(id, prompt, undefined, { model, attachments, thinkingLevel }).info };
  }

  runInfo(id: string): RunInfo | undefined {
    const info = this.busy.get(id)?.info ?? this.registry.get(id)?.run;
    return info && { ...info };
  }

  watchRun(id: string, runId: string, after: number, emit: (event: RunEvent) => void) {
    const run = this.busy.get(id);
    const info = this.runInfo(id);
    if (!info || info.id !== runId) throw new Error('Run not found');
    if (!Number.isSafeInteger(after) || after < 0 || after > info.sequence) throw new Error('Invalid event cursor');
    if (!run || after < (run.events[0]?.sequence ?? 1) - 1) {
      emit({ type: 'snapshot', messages: this.sessionMessages(id), partial: isRunning(info) ? run?.partial : undefined,
        tools: [...run?.tools.values() ?? []], run: info, sequence: info.sequence });
    } else {
      for (const event of run.events) if (event.sequence > after) emit(structuredClone(event));
    }
    if (run && isRunning(run.info)) run.listeners.add(emit);
    return () => { run?.listeners.delete(emit); };
  }

  cancel(id: string) {
    let cancelled = false;
    for (const child of this.registry.descendants([id])) {
      const run = this.busy.get(child);
      if (run) { cancelled = true; run.controller.abort(new Error('Agent run cancelled')); }
      const compaction = this.compactions.get(child);
      if (compaction) { cancelled = true; compaction.controller.abort(new Error('Compaction cancelled')); }
    }
    return cancelled;
  }

  private async runPrompt(record: NonNullable<ReturnType<SessionRegistry['get']>>, prompt: string,
      emit: (event: StreamEvent) => void, signal: AbortSignal, choice?: ModelChoice, images: ImageInput[] = [], thinkingLevel?: AgentSession['thinkingLevel']) {
    const { id } = record;
    signal.throwIfAborted();
    const session = await this.open(id);
    signal.throwIfAborted();
    const model = this.resolveModel(choice);
    if (model && (session.model?.provider !== model.provider || session.model?.id !== model.id))
      await session.setModel(model);
    signal.throwIfAborted();
    if (images.length && !session.model?.input.includes('image')) throw new Error('The selected model does not support image input. Choose an image-capable model and retry.');
    if (thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel);
    const actual = this.modelInfo(session.model);
    if (!record.parentId && !isDeepStrictEqual(this.settings.model, actual)) {
      const next = mergeSettings(this.settings, { model: actual });
      writeJson(this.paths.settings, next);
      this.settings = next;
    }
    this.registry.update(id, { model: actual });
    if (record.title === 'New conversation') this.registry.update(id, { title: prompt.trim().slice(0, 72) });
    const toolArguments = new Map<string, unknown>();
    const off = session.subscribe((event) => {
      switch (event.type) {
        case 'message_start':
          if (event.message.role === 'user') emit({ type: 'user', content: event.message.content, text: typeof event.message.content === 'string' ? event.message.content : event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') });
          if (event.message.role === 'assistant') emit({ type: 'assistant-start' });
          break;
        case 'message_update':
          if (event.assistantMessageEvent?.type === 'text_delta')
            emit({ type: 'delta', text: event.assistantMessageEvent.delta });
          break;
        case 'message_end':
          if (event.message.role === 'assistant') emit({ type: 'assistant-end' });
          break;
        case 'tool_execution_start':
          toolArguments.set(event.toolCallId, event.args);
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: 'running', arguments: event.args });
          break;
        case 'tool_execution_update':
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: 'running', arguments: toolArguments.get(event.toolCallId), content: event.partialResult?.content });
          break;
        case 'tool_execution_end': {
          const args = toolArguments.get(event.toolCallId) as { path?: string };
          const run = this.busy.get(id);
          if (!event.isError && ['write', 'edit'].includes(event.toolName) && typeof args?.path === 'string' && run) {
            const path = relative(this.paths.cwd, resolve(this.paths.cwd, args.path)).split(sep).join('/');
            run.info.changedFiles = [...new Set([...(run.info.changedFiles ?? []), path])];
          }
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: event.isError ? 'error' : 'finished',
            arguments: toolArguments.get(event.toolCallId), content: event.result?.content, sessionId: event.result?.details?.sessionId });
          break;
        }
      }
    });
    const cancel = () => { void session.abort().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await session.prompt(prompt, { images });
      signal.throwIfAborted();
      const last = session.messages.at(-1);
      if (last?.role === 'assistant' && last.errorMessage) throw new Error(last.errorMessage);
      const answer = session.getLastAssistantText() || '';
      emit({ type: 'complete', text: answer });
      return answer;
    } finally {
      signal.removeEventListener('abort', cancel);
      off();
      session.clearQueue();
      if (session.sessionFile && session.sessionFile !== this.registry.get(id)?.file) {
        this.registry.checkedFile({ cwd: record.cwd, file: session.sessionFile });
        this.registry.update(id, { file: session.sessionFile });
      }
    }
  }

  async compact(id: string) {
    if (this.busy.has(id) || this.compactions.has(id)) throw new Error('Stop the open conversation before compacting it');
    const controller = new AbortController();
    const done = this.open(id).then(async (session) => {
      controller.signal.throwIfAborted();
      const abort = () => session.abortCompaction();
      controller.signal.addEventListener('abort', abort, { once: true });
      try { await session.compact(); }
      finally { controller.signal.removeEventListener('abort', abort); }
    });
    this.compactions.set(id, { done, controller });
    try { await done; }
    finally { this.compactions.delete(id); }
  }

  async queueInput(id: string, text: string, mode: 'steer' | 'followUp', attachments?: Attachment[]) {
    if (!['steer', 'followUp'].includes(mode)) throw new Error('Invalid queue mode');
    const session = this.openSessions.get(id);
    if (!this.busy.has(id) || !session?.isStreaming) throw new Error('The agent is not streaming; send a new message');
    const input = prepareInput(text, attachments);
    if (session.getSteeringMessages().length + session.getFollowUpMessages().length >= 16) throw new Error('Queue is full');
    await session[mode](input.text, input.images);
    return { steer: session.getSteeringMessages(), followUp: session.getFollowUpMessages() };
  }

  async skills() {
    if (!this.settings.plugins.skills) return [];
    const loader = new DefaultResourceLoader({ cwd: this.paths.cwd, agentDir: this.paths.agent,
      settingsManager: SettingsManager.inMemory(), additionalSkillPaths: this.plugins.ctx.harnessSkills?.paths ?? [], noExtensions: true });
    await loader.reload();
    return loader.getSkills().skills.map(({ name, description }) => ({ name, description }));
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
    if (this.deleting.has(parentId)) throw new Error('Conversation is being deleted');
    requireChildDepth(this.registry.depth(parentId), this.settings.subagents.maxDepth);
    const model = this.resolveModel(choice);
    const record = this.registry.create({
      parentId, cwd: parent.cwd, title: task.slice(0, 72), model: model && this.modelInfo(model)
    });
    try {
      const text = await this.send(record.id, task, undefined, { signal });
      return { id: record.id, text };
    } catch (error) {
      if (this.registry.get(record.id)) this.registry.update(record.id, {
        title: (signal?.aborted || this.runInfo(record.id)?.state === 'cancelled' ? '[Cancelled] ' : '[Failed] ') + task.slice(0, 60)
      });
      throw error;
    }
  }

  export(ids: string[]) {
    const all = this.registry.descendants(ids);
    if (all.some((id) => this.busy.has(id) || this.openingSessions.has(id) || this.compactions.has(id)))
      throw new Error('Stop active conversations before exporting them');
    return this.registry.export(ids);
  }

  async delete(ids: string[]) {
    const all = this.registry.descendants(ids);
    if (all.some((id) => this.deleting.has(id))) throw new Error('Conversation is being deleted');
    for (const id of all) this.deleting.add(id);
    try {
      for (const id of ids) this.cancel(id);
      await Promise.allSettled(all.flatMap((id) => [this.busy.get(id)?.done, this.openingSessions.get(id), this.compactions.get(id)?.done]));
      for (const id of all) {
        this.openSessions.get(id)?.dispose();
        this.openSessions.delete(id);
        this.staleSessions.delete(id);
      }
      return this.registry.delete(ids);
    } finally { for (const id of all) this.deleting.delete(id); }
  }

  async updateSettings(patch: SettingsPatch) {
    if (this.configuring || this.stopping) throw new Error('Agent service is unavailable during reconfiguration or shutdown');
    const next = mergeSettings(this.settings, patch);
    this.resolveModel(next.model);
    if (next.subagents.provider) this.resolveModel({ provider: next.subagents.provider, id: next.subagents.model });
    const toolsChanged = this.plugins.needsUpdate(next);
    const previousDepth = this.settings.subagents.maxDepth;
    const depthChanged = next.subagents.maxDepth !== previousDepth;
    if (!toolsChanged) {
      writeJson(this.paths.settings, next);
      this.settings = next;
      this.semaphore.setLimit(next.subagents.maxParallel);
      if (depthChanged) for (const id of this.openSessions.keys()) {
        const depth = this.registry.depth(id);
        if ((depth < previousDepth) !== (depth < next.subagents.maxDepth)) this.staleSessions.add(id);
      }
      return next;
    }
    if (this.hasActiveWork)
      throw new Error('Stop active conversations before changing tools or Skills');
    const resources = new Map([...this.openSessions.keys()].map((id) => [id, this.plugins.resources(id)]));
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
          this.openSessions.get(id)?.dispose();
          this.openSessions.delete(id);
          this.staleSessions.delete(id);
        }
      }
      this.configuring = undefined;
    }
  }

  async stop() {
    this.stopping = true;
    this.approvals.close();
    for (const id of [...this.busy.keys(), ...this.compactions.keys()]) this.cancel(id);
    await Promise.allSettled([this.configuring, ...this.openingSessions.values(), ...[...this.compactions.values()].map(({ done }) => done), ...[...this.busy.values()].map(({ done }) => done)]);
    for (const session of this.openSessions.values()) session.dispose();
    this.openSessions.clear();
    await this.plugins.close();
    await this.models?.settleCredentialWrites();
  }
}
