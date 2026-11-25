
export interface TabScope {
  workspaceId: string;
  sessionId?: string;
}
export type TabOwner =
  | { workspaceId: string; sessionId?: never }
  | { workspaceId: string; sessionId: string };

export interface RightTab<T> {
  owner: TabOwner;
  key: string;
  data: T;
  signal?: AbortSignal;
}

export interface RightTabType<T> {
  title(data: T): string;
  create(data: T, scope: TabScope, signal: AbortSignal): HTMLElement;
}

export interface RightPanelEntry {
  title: string;
  icon: string;
  description: string;
  order?: number;
  open(scope: TabScope): void;
}

/** Layout owns tab state while the registered type owns its payload and view. */
export interface RightTabsPort {
  register<T>(type: string, definition: RightTabType<T>): { open(tab: RightTab<T>): void };
  contribute(id: string, entry: RightPanelEntry): void;
  onScopeChange(listener: () => void, signal: AbortSignal): () => void;
  inspect(title: string, node: HTMLElement, signal: AbortSignal): void;
}

export interface PageContribution {
  title: string;
  content: HTMLElement;
  order?: number;
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniLayout: { closeDrawer(restore?: boolean): void };
    miniHeader: { setTitle(title: string): void; showWorkspace(show: boolean): void };
    miniPages: {
      open(id?: string): void;
      register(id: string, node: HTMLElement): () => void;
      contribute(id: string, entry: PageContribution, signal: AbortSignal): () => void;
    };
    miniTabs: RightTabsPort & {
      selectScope(scope?: TabScope): void;
      prune(sessions: ReadonlySet<string>, workspaces: ReadonlySet<string>): void;
    };
    miniDialogs: {
      create(title: string, content: HTMLElement): { node: HTMLDialogElement; dispose(): void };
    };
  }
}

declare module '@mini-harness/ui-slots/browser/api' {
  interface SlotMap {
    'sidebar.primary': { kind: 'list' };
    'sidebar.actions': { kind: 'list' };
    'sidebar.navigation': { kind: 'list' };
    'sidebar.footer': { kind: 'list' };
    'conversation.header': { kind: 'list' };
    'workspace.header': { kind: 'single' };
    'conversation.body': { kind: 'single' };
    'dialog.root': { kind: 'list' };
  }
}
