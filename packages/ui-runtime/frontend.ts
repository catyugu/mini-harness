import { Context, type Fiber } from '../web/vendor/cordis.js';
import type { BrowserPrimitives } from '../contracts/browser.js';
import type { ComposerCommand } from '../web/contracts/commands.js';
import type { MessageContent, ViewMessage } from '../contracts/message.js';
import type { Attachment } from '../contracts/input.js';
import type { ModelChoice } from '../contracts/conversation.js';
import type { Conversation } from '../contracts/conversation.js';
import type { RightTabType, TabScope } from '../web/contracts/tabs.js';
import type { WorkspaceRecord } from '../contracts/workspace.js';
import type { SlotName, SlotKind } from '../ui-slots/registry.js';

export interface ToolView { name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string }
export interface Suggestion {
  label: string;
  description?: string;
  group?: string;
  icon?: 'file' | 'folder' | 'folder-open';
  depth?: number;
  expanded?: boolean;
  run(complete?: boolean): void;
}
export interface Completion {
  query: string;
  signal: AbortSignal;
  show(entries: Suggestion[], emptyText?: string): void;
  replace(text: string): void;
}
export type Completer = (request: Completion) => void | Promise<void>;

export interface MessageActionContext {
  readonly sessionId?: string;
  readonly leafId?: string | null;
  readonly message: ViewMessage;
  readonly rawText: string;
}
export interface MessageAction {
  id: string;
  label: string;
  successLabel?: string;
  icon: 'copy' | 'edit' | 'refresh';
  order?: number;
  visible(context: MessageActionContext): boolean;
  run(context: MessageActionContext): void | Promise<void>;
}
export interface DraftMode {
  title: string;
  text: string;
  submit(input: { text: string; attachments: Attachment[]; model?: ModelChoice; thinkingLevel?: string }): Promise<unknown>;
}
type Release = () => void | Promise<void>;

export interface FrontendApi {
  readonly ui: BrowserPrimitives;
  dialog(title: string, content: HTMLElement): HTMLDialogElement;
  page(id: string, entry: { title: string; content: HTMLElement; order?: number }): Release;
  readonly slots: {
    define(name: SlotName, container: HTMLElement, kind?: SlotKind): void;
    register(name: SlotName, node: HTMLElement, order?: number): () => void;
  };
  messageAction(action: MessageAction): Release;
  beginDraftMode(mode: DraftMode): void;
  cancelDraftMode(): void;
  command(command: ComposerCommand): () => void;
  completion(trigger: string, complete: Completer): Release;
  settingsPage(title: string, node: HTMLElement): Release;
  tool(name: string, render: (tool: ToolView) => HTMLElement | undefined): Release;
  toolAction(name: string, render: (tool: ToolView) => HTMLElement | undefined): Release;
  onDispose(cleanup: () => void | Promise<void>): Release;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  request<T>(path: string, options?: RequestInit): Promise<T>;
  insert(text: string): void;
  rightTab(type: string, definition: RightTabType): Release;
  openTab(type: string, path?: string, scope?: TabScope): void;
  inspect(title: string, content: HTMLElement): void;
}

export interface FrontendServices {
  workspaceRecord(id: string): WorkspaceRecord | undefined;
  openConversation(id: string): void;
  workspace(): TabScope | undefined;
  session(id?: string): Conversation | undefined;
  onConversationChange(listener: () => void, signal: AbortSignal): void;
  report(error: Error): void;
}
export type FrontendSetup = (ctx: Context, api: FrontendApi) => void | Release | Promise<void | Release>;

export class FrontendHost {
  private readonly plugins = new Map<string, { fiber: Fiber; controller: AbortController }>();
  private disposed = false;
  private draftOwner?: string;
  constructor(
    private readonly ctx: Context,
    private readonly request: <T>(path: string, options?: RequestInit) => Promise<T>,
    private readonly services: FrontendServices
  ) {
    this.ctx.provide('harnessBrowser', services);
  }

  async mount(id: string, setup: FrontendSetup, inject: string[], config: Record<string, unknown> = {}) {
    if (this.disposed) throw new Error('Browser host is disposed');
    await this.disable(id);
    if (this.disposed) throw new Error('Browser host is disposed');
    const controller = new AbortController();
    const root = this.ctx;
    const fiber = this.ctx.inject(inject, async (ctx) => {
      const own = (install: () => Release | Iterable<Release, void, void>) => {
        if (controller.signal.aborted) return () => {};
        return ctx.effect(install);
      };
      // One draft lease per plugin scope. A replacement belongs to the newest owner;
      // disposing an older plugin must not cancel somebody else's active draft.
      own(() => () => {
        if (this.draftOwner === id) { this.draftOwner = undefined; this.ctx.miniComposer.cancelDraftMode(); }
      });
      const cleanup = await setup(ctx, {
        signal: controller.signal,
        get ui() { return root.miniPrimitives; },
        dialog: (title, content) => {
          const dialog = this.ctx.miniPrimitives.dialog(title, content);
          own(() => this.ctx.miniSlots.register('dialog.root', dialog));
          own(() => () => dialog.close());
          return dialog;
        },
        page: (name, { title, content, order }) => {
          if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid page ID');
          const page = id + ':' + name;
          const entry = this.ctx.miniPrimitives.button(title, 'quiet');
          entry.classList.add('nav-action');
          entry.dataset.pageLink = page;
          entry.addEventListener('click', () => this.ctx.miniPages.open(page), { signal: controller.signal });
          return own(function* () {
            yield root.miniPages.register(page, content);
            yield root.miniSlots.register('sidebar.actions', entry, order);
          });
        },
        slots: {
          define: (name, container, kind) => { own(() => this.ctx.miniSlots.define(name, container, kind)); },
          register: (name, node, order) => own(() => this.ctx.miniSlots.register(name, node, order))
        },
        request: (path, options) => this.request(path, { ...options, signal: options?.signal
          ? AbortSignal.any([controller.signal, options.signal]) : controller.signal }),
        insert: (value) => { if (!controller.signal.aborted) this.ctx.miniComposer.insert(value); },
        beginDraftMode: (mode) => {
          if (controller.signal.aborted) return;
          this.draftOwner = id;
          this.ctx.miniComposer.beginDraftMode(mode);
        },
        cancelDraftMode: () => {
          if (!controller.signal.aborted && this.draftOwner === id) {
            this.draftOwner = undefined;
            this.ctx.miniComposer.cancelDraftMode();
          }
        },
        messageAction: (action) => own(() => this.ctx.miniMessages.registerAction(action)),
        rightTab: (type, definition) => own(() => this.ctx.miniTabs.register(id + ':' + type, definition)),
        openTab: (type, path, scope) => {
          if (!controller.signal.aborted) this.ctx.miniTabs.open(id + ':' + type, path, scope);
        },
        inspect: (title, content) => {
          if (!controller.signal.aborted) this.ctx.miniTabs.inspect(id, title, content, controller.signal);
        },
        config: Object.freeze(structuredClone(config)),
        command: (command) => own(() => this.ctx.miniComposer.command(command)),
        completion: (trigger, complete) => own(() => this.ctx.miniComposer.completion(trigger, complete)),
        settingsPage: (title, node) => own(() => this.ctx.miniSettingsPages.addPage(title, node)),
        tool: (name, render) => own(() => this.ctx.miniMessages.registerTool(name, render)),
        toolAction: (name, render) => own(() => this.ctx.miniMessages.registerTool(name, render, true)),
        onDispose: (dispose) => {
          if (controller.signal.aborted) { void Promise.resolve().then(dispose).catch(this.services.report); return () => {}; }
          return own(() => dispose);
        }
      });
      if (cleanup) {
        if (controller.signal.aborted) await cleanup();
        else own(() => cleanup);
      }
    });
    this.plugins.set(id, { fiber, controller });
    try { await fiber.await(); }
    catch (error) {
      await this.disable(id);
      throw error;
    }
  }

  async disable(id: string) {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    this.plugins.delete(id);
    plugin.controller.abort();
    await plugin.fiber.dispose();
  }

  async dispose() {
    this.disposed = true;
    for (const id of [...this.plugins.keys()].reverse()) {
      try { await this.disable(id); }
      catch (error) { this.services.report(error); }
    }
  }
}

declare module 'cordis' {
  interface Context {
    harnessBrowser: FrontendServices;
    miniPrimitives: BrowserPrimitives;
    miniComposer: {
      insert(text: string): void;
      beginDraftMode(mode: DraftMode): void;
      cancelDraftMode(): void;
      command(command: ComposerCommand): () => void;
      completion(trigger: string, complete: Completer): () => void;
    };
    miniSettingsPages: { addPage(title: string, node: HTMLElement): () => void };
  }
}
