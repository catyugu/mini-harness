import type {} from 'cordis';
import type { Conversation, ModelChoice, SessionRecord } from './conversation.js';
import type { WorkspaceRecord } from './workspace.js';
import type { RunAgentPort, ThinkingLevel } from './agent.js';
import type { RunEvent, RunInfo, StreamEvent } from './transport.js';
import type { ViewMessage } from './message.js';
import type { Attachment } from './input.js';
import type { InboxItem, QueueEntry } from './session-log.js';
import type { PluginMetadata, SessionRecords } from './plugins.js';
import type { Settings } from './config.js';

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
  records(id: string, pluginId: string): SessionRecords;
  log(id: string): import('./session-log.js').SessionLogPort;
  inspectLog<T>(id: string, read: (log: import('./session-log.js').SessionLogPort) => T, strict?: boolean): T | undefined;
  runSummary(id: string): RunInfo | undefined;
  logError(id: string): string | undefined;
  diagnostics(): { id: string; message: string }[];
  assertAvailable(id?: string, workspaceId?: string): void;
  beforeDelete(handler: { quiesce(ids: string[]): Promise<void>; release?(ids: string[]): void; busy?(id: string): boolean }): () => void;
  close(): void;
  workspacePath(id: string): string;
  depth(id: string): number;
  descendants(ids: string[]): string[];
  nativeFile(record: SessionRecord): string;
  modifiedAt(record: SessionRecord): string;
  export(ids: string[]): (SessionRecord & { log: string })[];
  delete(ids: string[]): Promise<string[]>;
  deleteWorkspace(id: string): Promise<{ removed: string; deleted: string[] }>;
}

export interface AgentPort extends RunAgentPort {
  readonly hasPending: boolean;
  prepare(id: string, signal?: AbortSignal): Promise<void>;
  activeModel(id: string): ModelChoice;
  read(id: string): { messages: ViewMessage[]; leafId: string | null; model: ModelChoice; thinkingLevel?: ThinkingLevel; queue: QueueEntry[] };
  queueInput(id: string, text: string, mode: 'steer' | 'followUp', attachments?: Attachment[],
    options?: Pick<InboxItem, 'model' | 'thinkingLevel'>): Promise<QueueEntry[]>;
  queue(id: string): QueueEntry[];
  cancelQueue(id: string, itemId?: string): QueueEntry[];
}

export interface RunPort {
  readonly size: number;
  readonly events: EventTarget;
  active(id: string): boolean;
  activeInScope(scopes: ReadonlySet<string>): boolean;
  completion(id: string): Promise<unknown> | undefined;
  view(id: string): { run?: RunInfo; partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[] };
  signal(id: string, signal?: AbortSignal): AbortSignal | undefined;
  send(id: string, prompt: string, emit?: (event: StreamEvent) => void, options?: {
    signal?: AbortSignal; model?: ModelChoice; attachments?: Attachment[];
    schedule?: (task: () => Promise<string>, signal: AbortSignal) => Promise<string>;
    thinkingLevel?: ThinkingLevel | null;
  }): Promise<string>;
  startRun(id: string, prompt: string, options?: {
    model?: ModelChoice; attachments?: Attachment[]; thinkingLevel?: ThinkingLevel | null;
  }): RunInfo;
  reviseAndStart(id: string, input: { sourceEntryId: string; expectedLeafId: string | null; message: string; removedImages?: number[];
    attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: ThinkingLevel | null }): Promise<RunInfo>;
  info(id: string): RunInfo | undefined;
  watch(id: string, runId: string, after: number, emit: (event: RunEvent) => void, end?: () => void): () => void;
  cancel(id: string): boolean;
  compact(id: string): Promise<void>;
  stop(): Promise<void>;
}

export interface SettingsPort {
  readonly settings: Settings;
  rememberModel(model: ModelChoice): void;
  forgetPlugin(id: string): void;
  forgetScopes(keys: string[]): void;
  subscribe(listener: () => void): () => void;
  validate(listener: (settings: Settings, previous: Settings) => void): () => void;
}

export interface ConversationViewPort {
  read(id: string): Conversation & {
    messages: ViewMessage[]; leafId: string | null; selectedModel: ModelChoice;
    thinkingLevel?: ThinkingLevel;
    partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[];
    queue: QueueEntry[];
  };
}

declare module 'cordis' {
  interface Context {
    harnessWorkspaces: WorkspacePort;
    harnessFileAccess: import('./files.js').FileAccessPort;
    harnessRegistry: SessionStore;
    harnessAgent: AgentPort;
    harnessRuns: RunPort;
    harnessConversationView: ConversationViewPort;
    harnessChanges: EventTarget;
    harnessApprovals: {
      readonly events: EventTarget;
      has(id: string): boolean;
      request(sessionId: string, runId: string | undefined, command: string, signal?: AbortSignal, context?: string): Promise<void>;
    };
    harnessProcess: import('./execution.js').ProcessExecutionPort;
    harnessSandbox: import('./execution.js').SandboxPort;
    harnessSettingsStore: SettingsPort;
    harnessUpdateSettings: (patch: unknown) => Promise<Settings>;
    harnessPluginCatalog: {
      metadata(): PluginMetadata[];
      reserved(id: string): boolean;
      diagnostics(): unknown;
    browser(): import('./browser.js').BrowserEntry[];
    };
  }
}
