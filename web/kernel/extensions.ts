import { Context, type Fiber } from '../vendor/cordis.js';
import type { ComposerCommand } from '../ui/commands.js';
import type { MessageContent, ViewMessage } from '../../src/protocol.js';
import type { Attachment } from '../../src/input.js';
import type { ModelChoice } from '../../src/registry.js';
import type { Conversation } from '../../src/registry.js';
import type { RightTabType, TabScope, createRightTabs } from '../right-tabs.js';
import type { Bootstrap } from '../types.js';

export type Slot = 'sidebar' | 'composer' | 'settings' | 'inspector' | 'approvals' | 'session-navigation' | 'conversation' | 'dialogs' | 'main' | 'conversation-header';
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
  mount(slot: Slot, node: HTMLElement, order?: number): void;
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
  private readonly contributions = new WeakMap<HTMLElement, number>();
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
    private slot: (name: Slot) => HTMLElement,
    private ui: Pick<FrontendApi, 'request' | 'insert' | 'beginDraftMode' | 'cancelDraftMode'> & { tabs(): ReturnType<typeof createRightTabs> },
    private services: FrontendServices,
    private addSettingsPage: (title: string, node: HTMLElement) => () => void,
    private registerCommand: (command: ComposerCommand) => () => void,
    private registerCompletion: (trigger: string, complete: Completer) => () => void
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

      const cleanup = await setup(ctx, {
        signal: controller.signal,
        request: (path, options) => this.ui.request(path, { ...options, signal: options?.signal
          ? AbortSignal.any([controller.signal, options.signal]) : controller.signal }),
        insert: (value) => { if (!controller.signal.aborted) this.ui.insert(value); },
        beginDraftMode: (mode) => {
          if (controller.signal.aborted) return;
          this.ui.beginDraftMode(mode);
          own(() => () => this.ui.cancelDraftMode());
        },
        cancelDraftMode: () => { if (!controller.signal.aborted) this.ui.cancelDraftMode(); },
        messageAction: (action) => own(() => {
          if (this.messageContributions.has(action.id)) throw new Error('Duplicate message action: ' + action.id);
          this.messageContributions.set(action.id, action);
          this.changedMessages();
          return () => { this.messageContributions.delete(action.id); this.changedMessages(); };
        }),
        rightTab: (type, definition) => own(() => this.ui.tabs().register(id + ':' + type, definition)),
        openTab: (type, path, scope) => {
          if (!controller.signal.aborted) this.ui.tabs().open(id + ':' + type, path, scope);
        },
        inspect: (title, content) => {
          if (!controller.signal.aborted) this.ui.tabs().inspect(id, title, content, controller.signal);
        },
        config: Object.freeze(structuredClone(config)),
        mount: (slot, node, order = 0) => own(() => {
          const container = this.slot(slot);
          const before = [...container.children].find((child) => (this.contributions.get(child as HTMLElement) ?? 0) > order);
          this.contributions.set(node, order);
          container.insertBefore(node, before ?? null);
          return () => node.remove();
        }),
        command: (command) => own(() => this.registerCommand(command)),
        completion: (trigger, complete) => own(() => this.registerCompletion(trigger, complete)),
        settingsPage: (title, node) => own(() => this.addSettingsPage(title, node)),
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
  interface Context { harnessBrowser: FrontendServices }
}
