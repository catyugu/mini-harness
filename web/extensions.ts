import { Context, type Fiber } from './vendor/cordis.js';
import type { ComposerCommand } from './commands.js';
import type { MessageContent } from '../src/protocol.js';
import type { Bootstrap } from './types.js';

export type Slot = 'sidebar' | 'composer' | 'settings' | 'inspector' | 'approvals' | 'session-navigation' | 'conversation' | 'dialogs' | 'main';
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

export interface FrontendApi {
  mount(slot: Slot, node: HTMLElement, order?: number): void;
  command(command: ComposerCommand): void;
  completion(trigger: string, complete: Completer): void;
  settingsPage(title: string, node: HTMLElement): void;
  tool(name: string, render: (tool: ToolView) => HTMLElement | undefined): void;
  toolAction(name: string, render: (tool: ToolView) => HTMLElement | undefined): void;
  onDispose(cleanup: () => void | Promise<void>): void;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  request<T>(path: string, options?: RequestInit): Promise<T>;
  insert(text: string): void;
  inspect(title: string, content: HTMLElement): void;
}

export interface FrontendServices {
  bootstrap(): Bootstrap;
  sessionTitle(id: string): string | undefined;
  openConversation(id: string): void;
  changedFiles(): string[];
  report(error: Error): void;
}
export type FrontendSetup = (api: FrontendApi, services: FrontendServices) => void | (() => void) | Promise<void | (() => void)>;

export class FrontendHost {
  private readonly ctx = new Context();
  private readonly fibers = new Map<string, Fiber>();
  private readonly contributions = new WeakMap<HTMLElement, number>();
  private readonly renderers = new Map<string, (tool: ToolView) => HTMLElement | undefined>();
  private readonly actions = new Map<string, (tool: ToolView) => HTMLElement | undefined>();

  constructor(
    private slot: (name: Slot) => HTMLElement,
    private ui: Pick<FrontendApi, 'request' | 'insert'> & { inspect(title: string, content: HTMLElement): () => void },
    private services: FrontendServices,
    private addSettingsPage: (title: string, node: HTMLElement) => () => void,
    private registerCommand: (command: ComposerCommand) => () => void,
    private registerCompletion: (trigger: string, complete: Completer) => () => void
  ) {
    this.ctx.provide('harnessBrowser', services);
  }

  async enable(id: string, setup: FrontendSetup, config: Record<string, unknown> = {}) {
    await this.disable(id);
    const controller = new AbortController();
    const fiber = this.ctx.inject(['harnessBrowser'], async (ctx) => {
      const own = (install: () => (() => void | Promise<void>)) => {
        if (!controller.signal.aborted) ctx.effect(install);
      };
      const registerRenderer = (registry: typeof this.renderers, name: string, render: (tool: ToolView) => HTMLElement | undefined) =>
        own(() => {
          if (registry.has(name)) throw new Error('Duplicate tool contribution: ' + name);
          registry.set(name, render);
          return () => { registry.delete(name); };
        });
      let closeInspector: (() => void) | undefined;
      own(() => () => closeInspector?.());
      const cleanup = await setup({
        signal: controller.signal,
        request: (path, options) => this.ui.request(path, { ...options, signal: options?.signal
          ? AbortSignal.any([controller.signal, options.signal]) : controller.signal }),
        insert: (value) => { if (!controller.signal.aborted) this.ui.insert(value); },
        inspect: (title, content) => {
          if (!controller.signal.aborted) closeInspector = this.ui.inspect(title, content);
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
      }, ctx.harnessBrowser);
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

  render(tool: ToolView, action = false) {
    try { return (action ? this.actions : this.renderers).get(tool.name)?.(tool); }
    catch (error) { this.services.report(error); }
  }
}

declare module 'cordis' {
  interface Context { harnessBrowser: FrontendServices }
}
