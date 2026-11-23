import { Context, type Fiber } from '../vendor/cordis.js';
import type { ComposerCommand } from '../contracts/commands.js';
import type { MessageContent, ViewMessage } from '../../contracts/message.js';
import type { Attachment } from '../../contracts/input.js';
import type { ModelChoice } from '../../contracts/conversation.js';
import type { Conversation } from '../../contracts/conversation.js';
import type { RightTabType, TabScope, RightTabsPort } from '../contracts/tabs.js';
import type { Bootstrap } from '../types.js';
import { SlotRegistry, type SlotName, type SlotKind } from '../../ui-slots/registry.js';

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
export interface FrontendApi {
  readonly slots: {
    define(name: SlotName, container: HTMLElement, kind?: SlotKind): void;
    register(name: SlotName, node: HTMLElement, order?: number): () => void;
  };
  messageAction(action: MessageAction): void;
  beginDraftMode(mode: DraftMode): void;
  cancelDraftMode(): void;
  command(command: ComposerCommand): () => void;
  completion(trigger: string, complete: Completer): void;
  settingsPage(title: string, node: HTMLElement): void;
  tool(name: string, render: (tool: ToolView) => HTMLElement | undefined): void;
  toolAction(name: string, render: (tool: ToolView) => HTMLElement | undefined): void;
  onDispose(cleanup: () => void | Promise<void>): void;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  request<T>(path: string, options?: RequestInit): Promise<T>;
  insert(text: string): void;
  rightTab(type: string, definition: RightTabType): void;
  openTab(type: string, path?: string, scope?: TabScope): void;
  inspect(title: string, content: HTMLElement): void;
}

export interface FrontendServices {
  bootstrap(): Bootstrap;
  openConversation(id: string): void;
  workspace(): TabScope | undefined;
  session(id?: string): Conversation | undefined;
  onConversationChange(listener: () => void, signal: AbortSignal): void;
  report(error: Error): void;
}
export type FrontendSetup = (api: FrontendApi, services: FrontendServices) => void | (() => void) | Promise<void | (() => void)>;

export interface BrowserPlugin {
  id: string;
  inject?: string[];
  setup(ctx: Context, api: FrontendApi): ReturnType<FrontendSetup>;
}

export class FrontendHost {
  private readonly plugins = new Map<string, { fiber: Fiber; controller: AbortController }>();
  private disposed = false;
  private draftOwner?: string;
  private readonly slots = new SlotRegistry();
  private readonly renderers = new Map<string, (tool: ToolView) => HTMLElement | undefined>();
  private readonly actions = new Map<string, (tool: ToolView) => HTMLElement | undefined>();
  private readonly messageContributions = new Map<string, MessageAction>();
  private readonly messageListeners = new Set<() => void>();

  messageActions() { return [...this.messageContributions.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
  onMessageActionsChanged(listener: () => void) {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }
  private changedMessages() { for (const listener of this.messageListeners) listener(); }

  constructor(
    private readonly ctx: Context,
    private readonly request: <T>(path: string, options?: RequestInit) => Promise<T>,
    private readonly services: FrontendServices
  ) {
    this.ctx.provide('harnessBrowser', services);
  }

  enable(id: string, setup: FrontendSetup, config: Record<string, unknown> = {}) {
    return this.mountPlugin({ id, inject: ['harnessBrowser'], setup: (ctx, api) => setup(api, ctx.harnessBrowser) }, config);
  }

  async mountPlugin({ id, inject = [], setup }: BrowserPlugin, config: Record<string, unknown> = {}) {
    if (this.disposed) throw new Error('Browser host is disposed');
    await this.disable(id);
    if (this.disposed) throw new Error('Browser host is disposed');
    const controller = new AbortController();
    const fiber = this.ctx.inject(inject, async (ctx) => {
      const own = (install: () => (() => void | Promise<void>)) => {
        if (controller.signal.aborted) return () => {};
        return ctx.effect(install);
      };
      const registerRenderer = (registry: typeof this.renderers, name: string, render: (tool: ToolView) => HTMLElement | undefined) =>
        own(() => {
          if (registry.has(name)) throw new Error('Duplicate tool contribution: ' + name);
          registry.set(name, render);
          return () => { registry.delete(name); };
        });

      // One draft lease per plugin scope. A replacement belongs to the newest owner;
      // disposing an older plugin must not cancel somebody else's active draft.
      own(() => () => {
        if (this.draftOwner === id) { this.draftOwner = undefined; this.ctx.miniComposer.cancelDraftMode(); }
      });
      const cleanup = await setup(ctx, {
        signal: controller.signal,
        slots: {
          define: (name, container, kind) => { own(() => this.slots.define(name, container, kind)); },
          register: (name, node, order) => own(() => this.slots.register(name, node, order))
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
        messageAction: (action) => own(() => {
          if (this.messageContributions.has(action.id)) throw new Error('Duplicate message action: ' + action.id);
          this.messageContributions.set(action.id, action);
          this.changedMessages();
          return () => { this.messageContributions.delete(action.id); this.changedMessages(); };
        }),
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
        tool: (name, render) => registerRenderer(this.renderers, name, render),
        toolAction: (name, render) => registerRenderer(this.actions, name, render),
        onDispose: (dispose) => {
          if (controller.signal.aborted) void Promise.resolve().then(dispose).catch(this.services.report);
          else own(() => dispose);
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

  render(tool: ToolView, action = false) {
    try { return (action ? this.actions : this.renderers).get(tool.name)?.(tool); }
    catch (error) { this.services.report(error); }
  }
}

declare module 'cordis' {
  interface Context {
    harnessBrowser: FrontendServices;
    miniComposer: {
      insert(text: string): void;
      beginDraftMode(mode: DraftMode): void;
      cancelDraftMode(): void;
      command(command: ComposerCommand): () => void;
      completion(trigger: string, complete: Completer): () => void;
      refreshTools(): void;
    };
    miniSettingsPages: { addPage(title: string, node: HTMLElement): () => void };
    miniTabs: RightTabsPort;
  }
}
