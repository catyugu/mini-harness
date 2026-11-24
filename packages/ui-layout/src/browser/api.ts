import type {} from 'cordis';
import type { BrowserContributionSource } from '@mini-harness/ui-runtime/contribution';

export interface TabScope { workspaceId: string; sessionId?: string }
export interface TabAddress extends TabScope { type: string; path?: string; mode?: string }
export interface RightTabType {
  title(address: TabAddress): string;
  create(address: TabAddress, signal: AbortSignal): HTMLElement;
  default?: boolean;
}

/** Browser plugin contract; independent from the concrete right panel implementation. */
export interface RightTabsPort {
  register(type: string, definition: RightTabType): () => void;
  open(type: string, path?: string, scope?: TabScope, mode?: string): void;
  inspect(owner: string, title: string, node: HTMLElement, signal: AbortSignal): void;
}

export interface PageContribution { title: string; content: HTMLElement; order?: number }

declare module 'cordis' {
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

export const layoutExtensions = {
  dialog(source: BrowserContributionSource, title: string, content: HTMLElement) {
    const { node, dispose } = source.service('miniDialogs').create(title, content);
    source.effect(() => dispose);
    return node;
  },
  page(source: BrowserContributionSource, name: string, entry: PageContribution) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid page ID');
    return source.effect(() => source.service('miniPages').contribute(source.id + ':' + name, entry, source.signal));
  },
  tab(source: BrowserContributionSource, type: string, definition: RightTabType) {
    return source.effect(() => source.service('miniTabs').register(source.id + ':' + type, definition));
  },
  openTab(source: BrowserContributionSource, type: string, path?: string, scope?: TabScope, mode?: string) {
    source.service('miniTabs').open(source.id + ':' + type, path, scope, mode);
  },
  inspect(source: BrowserContributionSource, title: string, content: HTMLElement) {
    source.service('miniTabs').inspect(source.id, title, content, source.signal);
  }
};

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
