import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader,
  type AgentSession, type CustomEntry
} from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { getPaths, type Paths } from '../../config.js';
import { prepareInput } from '../../input.js';
import type { Attachment, ImageInput } from '../../contracts/input.js';
import type { SessionStore } from '../../contracts/services.js';
import type { Conversation, ModelChoice } from '../../contracts/conversation.js';
import type { Context } from 'cordis';
import type { SessionRecords, ToolPort } from '../../contracts/plugins.js';
import type { StreamEvent } from '../../contracts/transport.js';
import type { ViewMessage } from '../../contracts/message.js';

export type ThinkingLevel = AgentSession['thinkingLevel'];

type Resources = [Context['harnessSkills'], ...ReturnType<ToolPort['resources']>];

export class PiSessions {
  private readonly openSessions = new Map<string, { session: AgentSession; resources: Resources }>();
  private readonly opening = new Map<string, Promise<AgentSession>>();
  private readonly staleSessions = new Set<string>();
  models!: ModelRuntime;

  constructor(
    private readonly paths: Paths,
    private readonly registry: SessionStore,
    private readonly ctx: Pick<Context, 'harnessSkills' | 'harnessTools'>,
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
  get hasPending() { return this.opening.size > 0; }
  get pending() { return this.opening.values(); }
  openingSession(id: string) { return this.opening.get(id); }
  private resources(id: string): Resources {
    return [this.ctx.harnessSkills, ...this.ctx.harnessTools.resources(id)];
  }

  reopenStale(id: string) {
    const entry = this.openSessions.get(id);
    if (!entry || this.isRunning(id)) return;
    const resources = this.resources(id);
    if (this.staleSessions.has(id) || entry.resources.length !== resources.length ||
        entry.resources.some((resource, i) => resource !== resources[i])) this.release(id);
  }

  reconcileResources() { for (const id of this.openSessions.keys()) this.reopenStale(id); }

  release(id: string) {
    this.openSessions.get(id)?.session.dispose();
    this.openSessions.delete(id);
    this.staleSessions.delete(id);
  }

  close() { for (const id of this.openSessions.keys()) this.release(id); }

  activeModel(id: string) {
    const session = this.openSessions.get(id)?.session;
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
    for (const [id, { session }] of this.openSessions) {
      if (session.model?.provider === provider) this.staleSessions.add(id);
    }
  }

  async open(id: string): Promise<AgentSession> {
    this.assertAvailable(id);
    this.reopenStale(id);
    const active = this.openSessions.get(id);
    if (active) return active.session;
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
    const resources = this.resources(id);
    const [skills, ...tools] = resources;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.paths.agent,
      settingsManager,
      additionalSkillPaths: skills?.paths(cwd) ?? [],
      noSkills: !skills,
      noExtensions: true
    });
    await loader.reload();
    const file = this.registry.checkedFile(item);
    const manager = file ? SessionManager.open(file, storage, cwd) :
      SessionManager.create(cwd, storage, { id: item.id });
    if (item.file !== manager.getSessionFile()) this.registry.update(id, { file: manager.getSessionFile() });
    const customTools = tools.map((tool) => tool.bind(id));
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
    this.openSessions.set(id, { session, resources });
    return session;
  }

  async records(id: string, pluginId: string): Promise<SessionRecords> {
    const { sessionManager } = await this.open(id);
    this.assertAvailable(id);
    const type = 'mini-harness:' + pluginId;
    return {
      list: () => sessionManager.getBranch()
        .filter((entry): entry is CustomEntry => entry.type === 'custom' && entry.customType === type)
        .map(({ id, timestamp, data }) => ({ id, timestamp, data: structuredClone(data) })),
      append: (data: unknown) => sessionManager.appendCustomEntry(type, JSON.parse(JSON.stringify(data)))
    };
  }

  messages(id: string): ViewMessage[] {
    const session = this.openSessions.get(id)?.session;
    if (!session) return [];
    const argumentsById = new Map<string, unknown>();
    const toolTimings = new Map<string, number>();
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== 'mini-harness:tool-timing') continue;
      const data = entry.data as { toolCallId?: unknown; elapsedMs?: unknown } | null;
      if (typeof data?.toolCallId === 'string' && typeof data.elapsedMs === 'number' && Number.isFinite(data.elapsedMs))
        toolTimings.set(data.toolCallId, data.elapsedMs);
    }
    const branch = session.sessionManager.getBranch();
    for (const entry of branch) if (entry.type === 'message' && entry.message.role === 'assistant') {
      for (const block of entry.message.content) if (block.type === 'toolCall') argumentsById.set(block.id, block.arguments);
    }
    // Render the selected Pi branch, not a flattened model-context projection. In particular,
    // compaction must not erase the identity of earlier messages or their editing targets.
    return branch.flatMap<ViewMessage>((entry) => {
      if (entry.type !== 'message') return [];
      const message = entry.message;
      const identity = { id: entry.id, parentId: entry.parentId };
      switch (message.role) {
        case 'user':
        case 'assistant':
          return [{
            ...identity, role: message.role, content: message.content, timestamp: message.timestamp,
            error: message.role === 'assistant' ? message.errorMessage : undefined
          }];
        case 'toolResult': {
          const code = message.details && typeof message.details === 'object' &&
            'exitCode' in message.details ? message.details.exitCode : undefined;
          return [{
            ...identity, role: message.role, content: message.content, timestamp: message.timestamp,
            arguments: argumentsById.get(message.toolCallId), toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError,
            sessionId: message.details && typeof message.details === 'object' && 'sessionId' in message.details &&
              typeof message.details.sessionId === 'string' ? message.details.sessionId : undefined,
            elapsedMs: toolTimings.get(message.toolCallId),
            exitCode: typeof code === 'number' && Number.isInteger(code) ? code : undefined
          }];
        }
        default: return [];
      }
    });
  }

  /** Validate an editable entry on the selected Pi branch and reject stale browser views. */
  async revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null) {
    if (typeof sourceEntryId !== 'string' || !/^[a-f0-9]{8,64}$/i.test(sourceEntryId) ||
        (expectedLeafId !== null && (typeof expectedLeafId !== 'string' || !/^[a-f0-9]{8,64}$/i.test(expectedLeafId))))
      throw new Error('Invalid revision target');
    const { sessionManager } = await this.open(id);
    if (sessionManager.getLeafId() !== expectedLeafId) throw new Error('Conversation changed; refresh before editing');
    const source = sessionManager.getBranch().find((entry) => entry.id === sourceEntryId);
    if (source?.type !== 'message' || source.message.role !== 'user') throw new Error('User message not found on active branch');
    return source;
  }

  async navigateForRevision(id: string, sourceEntryId: string, expectedLeafId: string | null) {
    await this.revisionTarget(id, sourceEntryId, expectedLeafId);
    const session = await this.open(id);
    const result = await session.navigateTree(sourceEntryId);
    if (result.cancelled) throw new Error('Revision navigation cancelled');
  }

  async prompt(record: Conversation, prompt: string, emit: (event: StreamEvent) => void, {
    signal, choice, images = [], thinkingLevel, changed, revision
  }: { signal: AbortSignal; choice?: ModelChoice; images?: ImageInput[]; thinkingLevel?: ThinkingLevel;
       changed?: (path: string) => void; revision?: { sourceEntryId: string; expectedLeafId: string | null } }) {
    const { id } = record;
    signal.throwIfAborted();
    const session = await this.open(id);
    signal.throwIfAborted();
    if (revision) {
      await this.navigateForRevision(id, revision.sourceEntryId, revision.expectedLeafId);
      signal.throwIfAborted();
    }
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
    const toolTimings: { toolCallId: string; elapsedMs: number }[] = [];
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
          const elapsedMs = call ? performance.now() - call.start : undefined;
          if (elapsedMs !== undefined) toolTimings.push({ toolCallId: event.toolCallId, elapsedMs });
          const code = event.result?.details?.exitCode;
          emit({ type: 'tool', id: event.toolCallId, name: event.toolName, state: event.isError ? 'error' : 'finished',
            arguments: call?.args, content: event.result?.content, sessionId: event.result?.details?.sessionId,
            elapsedMs, exitCode: typeof code === 'number' && Number.isInteger(code) ? code : undefined });
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
      for (const entry of toolTimings) session.sessionManager.appendCustomEntry('mini-harness:tool-timing', entry);
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
    const session = this.openSessions.get(id)?.session;
    if (!session?.isStreaming) throw new Error('The agent is not streaming; send a new message');
    const input = prepareInput(text, attachments);
    if (session.getSteeringMessages().length + session.getFollowUpMessages().length >= 16) throw new Error('Queue is full');
    await session[mode](input.text, input.images);
    return this.queue(session);
  }

}
