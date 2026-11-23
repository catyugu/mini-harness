import type {} from 'cordis';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Conversation, ModelChoice, SessionRecord } from './conversation.js';
import type { WorkspaceRecord } from './workspace.js';
import type { RunAgentPort } from './agent.js';
import type { RunEvent, RunInfo, StreamEvent } from './transport.js';
import type { ViewMessage } from './message.js';
import type { Attachment } from './input.js';
import type { PluginMetadata, SessionRecords } from './plugins.js';
import type { Settings, SettingsPatch } from './config.js';

/** Stable, implementation-free ports for the independently mounted product capabilities. */
export interface PluginConfigurationPort {
  effective(settings: Settings): Settings;
  configure(settings: Settings, commit?: () => void): Promise<void>;
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
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  create(input?: { parentId?: string | null; title?: string; workspaceId?: string }): SessionRecord;
  rename(id: string, title: string, source?: SessionRecord['titleSource']): SessionRecord;
  link(id: string, file: string): void;
  assertAvailable(id?: string, workspaceId?: string): void;
  beforeDelete(handler: { quiesce(ids: string[]): Promise<void>; release?(ids: string[]): void; busy?(id: string): boolean }): () => void;
  close(): void;
  workspacePath(id: string): string;
  depth(id: string): number;
  descendants(ids: string[]): string[];
  checkedFile(record: Pick<SessionRecord, 'piSessionRef' | 'workspaceId'>): string | undefined;
  modifiedAt(record: SessionRecord): string;
  checkSessionDirectory(path: string): string;
  export(ids: string[]): (Omit<SessionRecord, 'piSessionRef'> & { piSession: string | null })[];
  delete(ids: string[]): Promise<string[]>;
  deleteWorkspace(id: string): Promise<{ removed: string; deleted: string[] }>;
}

export interface AgentPort extends RunAgentPort {
  readonly models: ModelRuntime;
  readonly size: number;
  readonly hasPending: boolean;
  readonly pending: Iterable<Promise<AgentSession>>;
  open(id: string): Promise<AgentSession>;
  openingSession(id: string): Promise<AgentSession> | undefined;
  release(id: string): void;
  close(): void;
  availableModels(): { provider: string; id: string; name: string; configured: boolean; thinkingLevels: string[] }[];
  activeModel(id: string): ModelChoice;
  modelInfo(model: AgentSession['model']): ModelChoice;
  queue(session: AgentSession): unknown;
  read(id: string): { messages: ViewMessage[]; leafId: string | null; model: ModelChoice; thinkingLevel: AgentSession['thinkingLevel']; queue: unknown };
  queueInput(id: string, text: string, mode: 'steer' | 'followUp', attachments?: Attachment[]): Promise<unknown>;
  records(id: string, pluginId: string): Promise<SessionRecords>;
  invalidateProviderSessions(provider: string): void;
}

export interface RunPort {
  readonly size: number;
  readonly events: EventTarget;
  active(id: string): boolean;
  completion(id: string): Promise<unknown> | undefined;
  view(id: string): { run?: RunInfo; partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[] };
  signal(id: string, signal?: AbortSignal): AbortSignal | undefined;
  send(id: string, prompt: string, emit?: (event: StreamEvent) => void, options?: {
    signal?: AbortSignal; model?: ModelChoice; attachments?: Attachment[];
    schedule?: (task: () => Promise<string>, signal: AbortSignal) => Promise<string>;
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
  rememberModel(model: ModelChoice): void;
  forgetPlugin(id: string): void;
  subscribe(listener: () => void): () => void;
  validate(listener: (settings: Settings) => void): () => void;
}

export interface ConversationViewPort {
  read(id: string): Conversation & {
    messages: ViewMessage[]; leafId: string | null; selectedModel: ModelChoice;
    thinkingLevel: AgentSession['thinkingLevel'];
    partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[];
    queue: unknown;
  };
}

declare module 'cordis' {
  interface Context {
    harnessWorkspaces: WorkspacePort;
    harnessFiles?: { open(workspaceId: string): import('./files.js').WorkspaceFileAccess };
    harnessRegistry: SessionStore;
    harnessPi: AgentPort;
    harnessRuns: RunPort;
    harnessConversationView: ConversationViewPort;
    harnessChanges: EventTarget;
    harnessApprovals: {
      readonly events: EventTarget;
      has(id: string): boolean;
      request(sessionId: string, runId: string | undefined, command: string, signal?: AbortSignal): Promise<void>;
    };
    harnessProcess: { run(command: string, cwd: string, options: { mode: 'isolated' | 'host'; timeoutSeconds: number; signal?: AbortSignal }): Promise<{ code: number | null }> };
    harnessSettingsStore: SettingsPort;
    harnessUpdateSettings: (patch: SettingsPatch) => Promise<Settings>;
    harnessPluginCatalog: {
      metadata(): PluginMetadata[];
      reserved(id: string): boolean;
      browser(): import('./browser.js').BrowserEntry[];
    };
  }
}
