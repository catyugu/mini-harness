import type {} from 'cordis';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Conversation, ModelChoice } from './conversation.js';
import type { WorkspaceRecord } from './workspace.js';
import type { RunAgentPort } from './agent.js';
import type { RunEvent, RunInfo, StreamEvent } from './transport.js';
import type { ViewMessage } from './message.js';
import type { Attachment } from './input.js';
import type { PluginMetadata, SessionRecords } from './plugins.js';
import type { Settings, SettingsPatch } from './config.js';

/** Stable, implementation-free ports for the independently mounted product capabilities. */
export interface PluginConfigurationPort {
  configure(settings: Settings, commit?: () => void, beforeChange?: () => void): void | Promise<void>;
}

export interface WorkspacePort {
  readonly events: EventTarget;
  readonly defaultId: string | undefined;
  list(): WorkspaceRecord[];
  get(id: string): WorkspaceRecord;
  resolveRoot(root: string, id: string): string;
  register(path: string, name?: string): WorkspaceRecord;
  rename(id: string, name: string): WorkspaceRecord;
  reorder(ids: string[]): WorkspaceRecord[];
  remove(id: string): void;
  browse(path: string): { path: string; parent: string | null; directories: { name: string; path: string }[] };
}

export interface SessionStore {
  readonly events: EventTarget;
  readonly workspaces: WorkspacePort;
  get(id: string): Conversation | undefined;
  list(workspaceId?: string): Conversation[];
  create(input?: { parentId?: string | null; title?: string; workspaceId?: string; model?: ModelChoice }): Conversation;
  update(id: string, patch: Partial<Pick<Conversation, 'title' | 'file' | 'model' | 'run'>>): Conversation;
  workspacePath(id: string): string;
  depth(id: string): number;
  descendants(ids: string[]): string[];
  checkedFile(record: Pick<Conversation, 'file' | 'cwd'>): string | undefined;
  checkSessionDirectory(path: string): string;
  export(ids: string[]): (Omit<Conversation, 'file'> & { piSession: string | null })[];
  delete(ids: string[]): string[];
  notify(id: string, deleted?: boolean): void;
}

export interface AgentPort extends RunAgentPort {
  readonly models: ModelRuntime;
  readonly size: number;
  readonly hasPending: boolean;
  readonly pending: Iterable<Promise<AgentSession>>;
  start(): Promise<void>;
  open(id: string): Promise<AgentSession>;
  openingSession(id: string): Promise<AgentSession> | undefined;
  release(id: string): void;
  close(): void;
  reconcileResources(): void;
  availableModels(): { provider: string; id: string; name: string; configured: boolean; thinkingLevels: string[] }[];
  activeModel(id: string): ModelChoice;
  modelInfo(model: AgentSession['model']): ModelChoice;
  queue(session: AgentSession): unknown;
  queueInput(id: string, text: string, mode: 'steer' | 'followUp', attachments?: Attachment[]): Promise<unknown>;
  records(id: string, pluginId: string): Promise<SessionRecords>;
  invalidateProviderSessions(provider: string): void;
}

export interface RunPort {
  readonly size: number;
  active(id: string): boolean;
  completion(id: string): Promise<unknown> | undefined;
  view(id: string): { run?: RunInfo; partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[] };
  signal(id: string, signal?: AbortSignal): AbortSignal | undefined;
  send(id: string, prompt: string, emit?: (event: StreamEvent) => void, options?: {
    signal?: AbortSignal; model?: ModelChoice; attachments?: Attachment[];
    thinkingLevel?: AgentSession['thinkingLevel'];
  }): Promise<string>;
  startRun(id: string, prompt: string, options?: {
    model?: ModelChoice; attachments?: Attachment[]; thinkingLevel?: AgentSession['thinkingLevel'];
  }): RunInfo;
  reviseAndStart(id: string, input: { sourceEntryId: string; expectedLeafId: string | null; message: string;
    attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: AgentSession['thinkingLevel'] }): Promise<RunInfo>;
  info(id: string): RunInfo | undefined;
  watch(id: string, runId: string, after: number, emit: (event: RunEvent) => void): () => void;
  cancel(id: string): boolean;
  compact(id: string): Promise<void>;
  stop(): Promise<void>;
}

export interface SettingsPort {
  readonly settings: Settings;
  readonly changing: boolean;
  rememberModel(model: ModelChoice): void;
  forgetPlugin(id: string): void;
  subscribe(listener: () => void): () => void;
  validate(listener: (settings: Settings) => void): () => void;
}

export interface ConversationPort {
  readonly hasActiveWork: boolean;
  assertAvailable(id?: string): void;
  createConversation(input?: { workspaceId?: string }): Conversation;
  deleteWorkspace(id: string): Promise<{ removed: string; deleted: string[] }>;
  getConversation(id: string): Promise<Conversation & {
    messages: ViewMessage[]; leafId: string | null; selectedModel: ModelChoice;
    thinkingLevel: AgentSession['thinkingLevel'];
    partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[];
    queue: unknown;
  }>;
  export(ids: string[]): ReturnType<SessionStore['export']>;
  delete(ids: string[]): Promise<string[]>;
  stop(): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    harnessWorkspaces: WorkspacePort;
    harnessRegistry: SessionStore;
    harnessNavigation: () => { workspaces: WorkspaceRecord[]; sessions: (Conversation & { waitingApproval: boolean })[] };
    harnessPi: AgentPort;
    harnessRuns: RunPort;
    harnessOperations: ConversationPort;
    harnessSettingsStore: SettingsPort;
    harnessUpdateSettings: (patch: SettingsPatch) => Promise<Settings>;
    harnessPluginCatalog: {
      metadata(): PluginMetadata[];
      configuration(id: string): Record<string, unknown>;
      reserved(id: string): boolean;
    };
    harnessProviderCatalog: () => unknown[];
  }
}
