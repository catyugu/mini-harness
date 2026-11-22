import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader,
  type AgentSession, type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { getPaths, type Paths } from './config.js';
import { prepareInput, type Attachment, type ImageInput } from './input.js';
import type { Conversation, SessionRegistry, ModelChoice } from './registry.js';
import type { StreamEvent, ViewMessage } from './protocol.js';

export type ThinkingLevel = AgentSession['thinkingLevel'];

export class PiSessions {
  private readonly openSessions = new Map<string, AgentSession>();
  private readonly opening = new Map<string, Promise<AgentSession>>();
  private readonly staleSessions = new Set<string>();
  models!: ModelRuntime;

  constructor(
    private readonly paths: Paths,
    private readonly registry: SessionRegistry,
    private readonly plugins: { skills?: { paths(cwd: string): string[] }; getTools(id: string): ToolDefinition[] },
    private readonly defaultModel: () => ModelChoice,
    private readonly rememberModel: (model: ModelChoice) => void,
    private readonly assertAvailable: (id: string) => void,
    private readonly isRunning: (id: string) => boolean
  ) {}

  async start() {
    this.models = await ModelRuntime.create({
      authPath: join(this.paths.home, 'auth.json'),
      modelsPath: join(this.paths.home, 'models.json'),
      refreshOnCreate: false
    });
    await this.models.getAvailable();
  }

  get size() { return this.openSessions.size; }
  get ids() { return this.openSessions.keys(); }
  get hasPending() { return this.opening.size > 0; }
  get pending() { return this.opening.values(); }
  openingSession(id: string) { return this.opening.get(id); }
  markStale(id: string) { this.staleSessions.add(id); }
  reopenStale(id: string) { if (this.staleSessions.has(id)) this.release(id); }

  release(id: string) {
    this.openSessions.get(id)?.dispose();
    this.openSessions.delete(id);
    this.staleSessions.delete(id);
  }

  close() { for (const id of this.ids) this.release(id); }

  activeModel(id: string) {
    const session = this.openSessions.get(id);
    if (!session) throw new Error('Parent session not open');
    return this.modelInfo(session.model);
  }

  queue(session: AgentSession) {
    return { steer: session.getSteeringMessages(), followUp: session.getFollowUpMessages() };
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

  resolveModel(choice: ModelChoice = this.defaultModel(), missingOk = false) {
    if (!choice?.provider) {
      if (choice?.id) throw new Error('A model ID requires a provider');
      return undefined;
    }
    // A provider-only override selects one of its available models.
    const id = choice.id || this.models.getAvailableSnapshot().find((m) => m.provider === choice.provider)?.id ||
      this.models.getModels(choice.provider)[0]?.id;
    if (!id) {
      if (!missingOk) throw new Error('No model is available for provider: ' + choice.provider);
      return undefined;
    }
    const model = this.models.getModel(choice.provider, id);
    if (!model && !missingOk) throw new Error('Unknown model: ' + choice.provider + '/' + id);
    return model;
  }

  invalidateProviderSessions(provider: string) {
    for (const [id, session] of this.openSessions) {
      if (session.model?.provider === provider) this.staleSessions.add(id);
    }
  }

  async open(id: string): Promise<AgentSession> {
    this.assertAvailable(id);
    const active = this.openSessions.get(id);
    if (active && (!this.staleSessions.has(id) || this.isRunning(id))) return active;
    if (active) this.release(id);
    const pending = this.opening.get(id);
    if (pending) return pending;
    const opening = this.openNewSession(id);
    this.opening.set(id, opening);
    try { return await opening; }
    finally { this.opening.delete(id); }
  }

  private async openNewSession(id: string): Promise<AgentSession> {
    const item = this.registry.get(id);
    if (!item) throw new Error('Conversation not found');
    const cwd = this.registry.workspaces.resolveRoot(item.cwd, item.workspaceId);
    const storage = getPaths(item.cwd, { MINI_HARNESS_HOME: this.paths.home }).sessions;
    mkdirSync(storage, { recursive: true, mode: 0o700 });
    this.registry.checkSessionDirectory(storage);
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.paths.agent,
      settingsManager,
      additionalSkillPaths: this.plugins.skills?.paths(cwd) ?? [],
      noSkills: !this.plugins.skills,
      noExtensions: true
    });
    await loader.reload();
    const file = this.registry.checkedFile(item);
    const manager = file ? SessionManager.open(file, storage, cwd) :
      SessionManager.create(cwd, storage, { id: item.id });
    if (item.file !== manager.getSessionFile()) this.registry.update(id, { file: manager.getSessionFile() });
    const customTools = this.plugins.getTools(id);
    const recordedModel = item.model && this.resolveModel(item.model, true);
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.paths.agent,
      modelRuntime: this.models,
      model: recordedModel,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      tools: customTools.map((tool) => tool.name),
      customTools
    });
    if (recordedModel && (session.model?.provider !== recordedModel.provider || session.model?.id !== recordedModel.id)) {
      try { await session.setModel(recordedModel); }
      catch (error) { session.dispose(); throw error; }
    }
    this.openSessions.set(id, session);
    return session;
  }

  messages(id: string): ViewMessage[] {
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

  async prompt(record: Conversation, prompt: string,
      emit: (event: StreamEvent) => void, signal: AbortSignal, choice?: ModelChoice, images: ImageInput[] = [], thinkingLevel?: ThinkingLevel, changed?: (path: string) => void) {
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
    if (!record.parentId) this.rememberModel(actual);
    this.registry.update(id, { model: actual });
    if (record.title === 'New conversation') this.registry.update(id, { title: prompt.trim().slice(0, 72) });
    const toolCalls = new Map<string, { args: unknown; start: number }>();
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
          toolCalls.set(event.toolCallId, { args: event.args, start: performance.now() });
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: 'running', arguments: event.args });
          break;
        case 'tool_execution_update':
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: 'running', arguments: toolCalls.get(event.toolCallId)?.args, content: event.partialResult?.content });
          break;
        case 'tool_execution_end': {
          const call = toolCalls.get(event.toolCallId);
          toolCalls.delete(event.toolCallId);
          const changedPath = event.result?.details?.changedPath;
          if (!event.isError && typeof changedPath === 'string') changed?.(changedPath);
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: event.isError ? 'error' : 'finished',
            arguments: call?.args, content: event.result?.content, sessionId: event.result?.details?.sessionId,
            elapsedMs: call ? performance.now() - call.start : undefined });
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

  async compact(id: string, signal: AbortSignal) {
    const session = await this.open(id);
    signal.throwIfAborted();
    const abort = () => session.abortCompaction();
    signal.addEventListener('abort', abort, { once: true });
    try { await session.compact(); }
    finally { signal.removeEventListener('abort', abort); }
  }

  async queueInput(id: string, text: string, mode: 'steer' | 'followUp', attachments?: Attachment[]) {
    if (!['steer', 'followUp'].includes(mode)) throw new Error('Invalid queue mode');
    const session = this.openSessions.get(id);
    if (!session?.isStreaming) throw new Error('The agent is not streaming; send a new message');
    const input = prepareInput(text, attachments);
    if (session.getSteeringMessages().length + session.getFollowUpMessages().length >= 16) throw new Error('Queue is full');
    await session[mode](input.text, input.images);
    return this.queue(session);
  }

}
