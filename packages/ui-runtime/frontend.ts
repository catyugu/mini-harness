import type { PluginConfiguration } from '@mini-harness/contracts/config';
import { SettingsRegistry, type SettingsContribution } from './settings.js';
import { Context, type Fiber } from '@mini-harness/web/vendor/cordis';
import type { BrowserPrimitives, BrowserProjectionPort } from '@mini-harness/contracts/browser';
import type { ComposerCommand } from '@mini-harness/contracts/composer';
import type { MessageContent, ViewMessage } from '@mini-harness/contracts/message';
import type { Attachment } from '@mini-harness/contracts/input';
import type { ModelChoice } from '@mini-harness/contracts/conversation';
import type { Conversation } from '@mini-harness/contracts/conversation';
import type { RightTabType, TabScope } from '@mini-harness/contracts/layout';
import type { WorkspaceRecord } from '@mini-harness/contracts/workspace';
import type { SlotName, SlotKind, SlotRenderer, KeyedSlotOptions } from '@mini-harness/ui-slots/registry';

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
  images?: Attachment[];
  submit(input: { text: string; attachments: Attachment[]; removedImages: number[]; model?: ModelChoice; thinkingLevel?: string | null }): Promise<import('@mini-harness/contracts/transport').RunInfo>;
}
type Release = () => void | Promise<void>;

export interface FrontendApi {
  readonly ui: BrowserPrimitives;
  dialog(title: string, content: HTMLElement): HTMLDialogElement;
  page(id: string, entry: { title: string; content: HTMLElement; order?: number }): Release;
  readonly slots: {
    define(name: SlotName, container: HTMLElement, kind?: SlotKind): void;
    register(name: SlotName, node: HTMLElement, order?: number): () => void;
    registerKeyed(name: SlotName, key: string, render: SlotRenderer, options?: KeyedSlotOptions): Release;
  };
  messageAction(action: MessageAction): Release;
  beginDraftMode(mode: DraftMode): void;
  cancelDraftMode(): void;
  command(command: ComposerCommand): () => void;
  completion(trigger: string, complete: Completer): Release;
  readonly settings: { register(contribution: SettingsContribution): Release };
  readonly configuration: PluginConfiguration;
  tool(name: string, render: (tool: ToolView) => HTMLElement | undefined): Release;
  toolAction(name: string, render: (tool: ToolView) => HTMLElement | undefined): Release;
  onDispose(cleanup: () => void | Promise<void>): Release;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  /** Refresh a plugin-owned snapshot when this plugin invalidates its state. */
  watch(refresh: () => void | Promise<void>): Release;
  readonly locale: {
    current(): string;
    subscribe(listener: (language: string) => void): Release;
    text(messages: Record<string, string>, fallback: string): string;
  };
  request<T>(path: string, options?: RequestInit): Promise<T>;
  insert(text: string): void;
  rightTab(type: string, definition: RightTabType): Release;
  openTab(type: string, path?: string, scope?: TabScope, mode?: string): void;
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
  private readonly plugins = new Map<string, { fiber: Fiber; controller: AbortController; configure(config: Record<string, unknown>): void }>();
  private disposed = false;
  private draftOwner?: string;
  constructor(
    private readonly ctx: Context,
    private readonly request: <T>(path: string, options?: RequestInit) => Promise<T>,
    private readonly report: (error: Error) => void
  ) {
    ctx.provide('miniSettingsRegistry', new SettingsRegistry());
  }

  async mount(id: string, setup: FrontendSetup, inject: string[], config: Record<string, unknown> = {}) {
    if (this.disposed) throw new Error('Browser host is disposed');
    await this.disable(id);
    if (this.disposed) throw new Error('Browser host is disposed');
    const controller = new AbortController();
    const root = this.ctx;
    let installed = false;
    let snapshot = Object.freeze(structuredClone(config));
    const listeners = new Set<() => void>();
    const readValue = <T>(key: string): T => {
      controller.signal.throwIfAborted();
      return (Object.hasOwn(snapshot, key) ? structuredClone(snapshot[key]) : undefined) as T;
    };
    const patch = async (values: Record<string, unknown>) => {
      controller.signal.throwIfAborted();
      if (!installed) throw new Error('Plugin settings cannot be written during browser setup');
      await this.request('/settings/plugins/' + encodeURIComponent(id), {
        method: 'PATCH', body: JSON.stringify(values), signal: controller.signal
      });
      await root.miniSwitch();
    };
    const configuration: PluginConfiguration = {
      get: readValue, patch,
      set: (key, value) => patch({ [key]: value }),
      subscribe<T>(key: string, listener: (value: T) => void) {
        let previous = JSON.stringify(readValue(key));
        const changed = () => {
          const value = readValue<T>(key);
          const serialized = JSON.stringify(value);
          if (serialized === previous) return;
          previous = serialized;
          listener(value);
        };
        listeners.add(changed);
        return () => { listeners.delete(changed); };
      }
    };
    controller.signal.addEventListener('abort', () => listeners.clear(), { once: true });
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
          const frame = document.createElement('section');
          frame.className = 'plugin-page';
          frame.tabIndex = -1;
          const header = document.createElement('header');
          const heading = document.createElement('h1');
          heading.textContent = title;
          header.append(heading);
          const body = document.createElement('div');
          body.className = 'plugin-page-body';
          body.append(content);
          frame.append(header, body);
          return own(function* () {
            yield root.miniPages.register(page, frame);
            yield root.miniSlots.register('sidebar.actions', entry, order);
          });
        },
        slots: {
          define: (name, container, kind) => { own(() => this.ctx.miniSlots.define(name, container, kind)); },
          register: (name, node, order) => own(() => this.ctx.miniSlots.register(name, node, order)),
          registerKeyed: (name, key, render, options) => own(() => this.ctx.miniSlots.registerKeyed(name, key, render, options)),
        },
        watch: (refresh) => own(() => root.miniProjections.register('plugin:' + id, { sync: refresh })),
        locale: {
          current: () => navigator.language,
          subscribe: (listener) => {
            const change = () => listener(navigator.language);
            window.addEventListener('languagechange', change, { signal: controller.signal });
            return () => window.removeEventListener('languagechange', change);
          },
          text: (messages, fallback) => messages[navigator.language] ?? messages[navigator.language.split('-')[0]] ?? fallback
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
        openTab: (type, path, scope, mode) => {
          if (!controller.signal.aborted) this.ctx.miniTabs.open(id + ':' + type, path, scope, mode);
        },
        inspect: (title, content) => {
          if (!controller.signal.aborted) this.ctx.miniTabs.inspect(id, title, content, controller.signal);
        },
        get config() { return snapshot; },
        configuration,
        command: (command) => own(() => this.ctx.miniComposer.command(command)),
        completion: (trigger, complete) => own(() => this.ctx.miniComposer.completion(trigger, complete)),
        settings: {
          register: (contribution) => own(() => root.miniSettingsRegistry.register(id, contribution, configuration))
        },
        tool: (name, render) => own(() => this.ctx.miniMessages.registerTool(name, render)),
        toolAction: (name, render) => own(() => this.ctx.miniMessages.registerTool(name, render, true)),
        onDispose: (dispose) => {
          if (controller.signal.aborted) { void Promise.resolve().then(dispose).catch(this.report); return () => {}; }
          return own(() => dispose);
        }
      });
      if (cleanup) {
        if (controller.signal.aborted) await cleanup();
        else own(() => cleanup);
      }
    });
    this.plugins.set(id, { fiber, controller, configure: (next) => {
      snapshot = Object.freeze(structuredClone(next));
      for (const listener of listeners) {
        try { listener(); }
        catch (error) { this.report(error instanceof Error ? error : new Error(String(error))); }
      }
    } });
    try { await fiber.await(); installed = true; }
    catch (error) {
      await this.disable(id);
      throw error;
    }
  }

  configure(id: string, config: Record<string, unknown>) {
    this.plugins.get(id)?.configure(config);
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
      catch (error) { this.report(error instanceof Error ? error : new Error(String(error))); }
    }
  }
}

declare module 'cordis' {
  interface Context {
    harnessBrowser: FrontendServices;
    miniPrimitives: BrowserPrimitives;
    miniProjections: BrowserProjectionPort;
    miniComposer: {
      insert(text: string): void;
      beginDraftMode(mode: DraftMode): void;
      cancelDraftMode(): void;
      command(command: ComposerCommand): () => void;
      completion(trigger: string, complete: Completer): () => void;
    };
    miniSettingsRegistry: SettingsRegistry;
  }
}
