import { ContributionRegistry, type Contribution, type Region } from './contributions.js';
import { Context, type Fiber } from './vendor/cordis.js';
import type { ComposerCommand } from './commands.js';
import type { MessageContent, RunEvent, ViewMessage } from '../src/protocol.js';
import type { Conversation } from '../src/registry.js';
import type { RightTabType, TabScope, createRightTabs } from './right-tabs.js';
import type { Bootstrap } from './types.js';

export type Slot = 'conversation.input.permission' | 'conversation.input.dock' | 'conversation.composer.dock' | 'sidebar' | 'composer' | 'settings' | 'inspector' | 'approvals' | 'session-navigation' | 'conversation' | 'dialogs' | 'main' | 'conversation-header';
export interface ToolView { details?: unknown; id?: string; name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string }
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

export interface FrontendApi {
  contribute<T>(region: Region, contribution: Omit<Contribution<T>, 'owner'>): () => void;
  contributions<T>(region: Region, key?: string, context?: unknown): Contribution<T>[];
  watchContributions(listener: (region: string) => void): void;
  mount(slot: Slot, node: HTMLElement, order?: number): void;
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
  sessionTitle(id: string): string | undefined;
  openConversation(id: string): void;
  workspace(): TabScope | undefined;
  currentConversation(): Conversation | undefined;
  session(id: string): Conversation | undefined;
  onConversationChange(listener: () => void, signal: AbortSignal): void;
  changedFiles(): string[];
  openResource(resource: { path: string; kind?: 'file' | 'diff' | 'terminal'; line?: number }): void;
  onRunEvent(listener: (event: RunEvent) => void, signal: AbortSignal): void;
  report(error: Error): void;
}
export type FrontendSetup = (api: FrontendApi, services: FrontendServices) => void | (() => void) | Promise<void | (() => void)>;

export interface BrowserPlugin {
  id: string;
  inject?: string[];
  setup(ctx: Context, api: FrontendApi): ReturnType<FrontendSetup>;
}

export class FrontendHost {
  private readonly fibers = new Map<string, Fiber>();
  readonly registry = new ContributionRegistry();
  private readonly mountedNodes = new Map<string, HTMLElement[]>();
  private readonly pages = new Map<unknown, () => void>();
  private readonly tabs = new Map<unknown, () => void>();
  private readonly lifetime = new AbortController();
  private nextId = 0;

  constructor(
    private readonly ctx: Context,
    private slot: (name: Slot) => HTMLElement,
    private ui: Pick<FrontendApi, 'request' | 'insert'> & { tabs(): ReturnType<typeof createRightTabs> },
    private services: FrontendServices,
    private addSettingsPage: (title: string, node: HTMLElement) => () => void,
    private registerCommand: (command: ComposerCommand) => () => void,
    private registerCompletion: (trigger: string, complete: Completer) => () => void
  ) {
    this.ctx.provide('harnessBrowser', services);
    for (const name of ['sidebar', 'composer', 'settings', 'inspector', 'approvals', 'session-navigation', 'conversation', 'dialogs', 'main', 'conversation-header'])
      this.registry.define('mount:' + name, 'list');
    this.registry.watch((region) => this.refreshRegion(region));
    services.onConversationChange(() => {
      for (const region of this.mountedNodes.keys()) this.refreshRegion(region);
      this.refreshRegion('settings.section');
    }, this.lifetime.signal);
  }

  enable(id: string, setup: FrontendSetup, config: Record<string, unknown> = {}) {
    return this.mountPlugin({ id, inject: ['harnessBrowser'], setup: (ctx, api) => setup(api, ctx.harnessBrowser) }, config);
  }

  async mountPlugin({ id, inject = [], setup }: BrowserPlugin, config: Record<string, unknown> = {}) {
    await this.disable(id);
    for (const dependency of inject) if (!this.ctx[dependency]) throw new Error('Missing browser service: ' + dependency);
    const controller = new AbortController();
    const fiber = this.ctx.inject(inject, async (ctx) => {
      const own = (install: () => (() => void | Promise<void>)) => {
        if (controller.signal.aborted) return () => {};
        return ctx.effect(install);
      };
      const contribute = <T>(region: string, item: Omit<Contribution<T>, 'owner'>) =>
        own(() => this.registry.register(region, { ...item, owner: id }));
      const registerRenderer = (region: Region, name: string, render: (tool: ToolView) => HTMLElement | undefined) =>
        contribute(region, { id: name, key: name, value: render });

      const cleanup = await setup(ctx, {
        contribute,
        contributions: (region, key, context) => this.registry.resolve(region, this.services.workspace(), key, context),
        watchContributions: (listener) => { own(() => this.registry.watch(listener)); },
        signal: controller.signal,
        request: (path, options) => this.ui.request(path, { ...options, signal: options?.signal
          ? AbortSignal.any([controller.signal, options.signal]) : controller.signal }),
        insert: (value) => { if (!controller.signal.aborted) this.ui.insert(value); },
        rightTab: (type, definition) => contribute('sidebar.right.pane.tab', { id: id + ':' + type, key: id + ':' + type, value: definition }),
        openTab: (type, path, scope) => {
          if (!controller.signal.aborted) this.ui.tabs().open(id + ':' + type, path, scope);
        },
        inspect: (title, content) => own(() => this.ui.tabs().inspect(id, title, content)),
        config: Object.freeze(structuredClone(config)),
        mount: (slot, node, order = 0) => contribute(slot.includes('.') ? slot : 'mount:' + slot,
          { id: id + ':node:' + ++this.nextId, value: node, order }),
        command: (command) => own(() => this.registerCommand(command)),
        completion: (trigger, complete) => own(() => this.registerCompletion(trigger, complete)),
        settingsPage: (title, node) => contribute('settings.section', { id: title, value: { title, node } }),
        tool: (name, render) => registerRenderer('tool.call.toolview', name, render),
        toolAction: (name, render) => registerRenderer('tool.call.action', name, render),
        onDispose: (dispose) => {
          if (controller.signal.aborted) void Promise.resolve().then(dispose).catch(this.services.report);
          else own(() => dispose);
        }
      });
      if (cleanup) own(() => cleanup);
    });
    this.fibers.set(id, fiber);
    this.controllers.set(id, controller);
    try { await fiber.await(); }
    catch (error) { await this.disable(id); throw error; }
  }

  private readonly controllers = new Map<string, AbortController>();

  async disable(id: string) {
    const fiber = this.fibers.get(id);
    this.fibers.delete(id);
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    try { await fiber?.dispose(); }
    catch (error) { this.services.report(error); }
  }

  async dispose() {
    this.lifetime.abort();
    for (const id of [...this.fibers.keys()].reverse()) await this.disable(id);
  }

  private refreshRegion(region: string) {
    const entries = this.registry.resolve<any>(region, this.services.workspace());
    if (region.startsWith('mount:') || ['sidebar.panellist', 'conversation.input.permission', 'conversation.input.dock', 'conversation.composer.dock'].includes(region)) {
      const slot = region === 'sidebar.panellist' ? 'sidebar' : region.replace('mount:', '') as Slot;
      const nodes = entries.map(({ value }) => value as HTMLElement);
      for (const previous of this.mountedNodes.get(region) ?? []) if (!nodes.includes(previous)) previous.remove();
      const container = this.slot(slot);
      if (nodes.length && !container) throw new Error('Unavailable UI outlet: ' + slot);
      const existing = container ? [...container.children].filter((node) => nodes.includes(node as HTMLElement)) : [];
      if (existing.length !== nodes.length || existing.some((node, index) => node !== nodes[index])) container.append(...nodes);
      this.mountedNodes.set(region, nodes);
    } else if (region === 'settings.section' || region === 'sidebar.right.pane.tab') {
      const installed = region === 'settings.section' ? this.pages : this.tabs;
      const values = new Set(entries.map(({ value }) => value));
      for (const [value, dispose] of installed) if (!values.has(value)) { dispose(); installed.delete(value); }
      for (const { key, value } of entries) if (!installed.has(value)) {
        installed.set(value, region === 'settings.section' ? this.addSettingsPage(value.title, value.node) : this.ui.tabs().register(key, value));
      }
    }
  }

  chat(message: ViewMessage) {
    try {
      return this.registry.resolve<(message: ViewMessage) => HTMLElement>('conversation.chat.node', this.services.workspace(), undefined, message)[0]?.value(message);
    } catch (error) { this.services.report(error); }
  }

  render(tool: ToolView, action = false) {
    try {
      const render = this.registry.resolve<(tool: ToolView) => HTMLElement>(action ? 'tool.call.action' : 'tool.call.toolview', this.services.workspace(), tool.name)[0]?.value;
      return render?.(tool);
    }
    catch (error) { this.services.report(error); }
  }
}

declare module 'cordis' {
  interface Context { harnessBrowser: FrontendServices }
}
