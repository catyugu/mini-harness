import type { ComposerCommand } from './commands.js';
import type { MessageContent } from '../src/protocol.js';

export type Slot = 'sidebar' | 'composer' | 'settings' | 'inspector';
export interface ToolView { name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string }
export interface FrontendApi {
  /** The host removes mounted nodes and listeners on disable/reconfigure. */
  mount(slot: Slot, node: HTMLElement): void;
  command(command: ComposerCommand): void;
  settingsPage(title: string, node: HTMLElement): void;
  tool(name: string, render: (tool: ToolView) => HTMLElement | undefined): void;
  onDispose(cleanup: () => void): void;
  readonly config: Readonly<Record<string, unknown>>;
  request<T>(path: string, options?: RequestInit): Promise<T>;
  insert(text: string): void;
  inspect(title: string, content: HTMLElement): void;
}
export interface FrontendPlugin { id: string; setup(api: FrontendApi): void | (() => void) | Promise<void | (() => void)> }

/** Owned contributions and deterministic disposal; no browser framework required. */
export class FrontendHost {
  private mounted = new Map<string, (() => void)[]>();
  private renderers = new Map<string, { owner: string; render: (tool: ToolView) => HTMLElement | undefined }>();
  constructor(private slots: Record<Slot, HTMLElement>, private services: Pick<FrontendApi, 'request' | 'insert' | 'inspect'>,
    private report: (error: Error) => void, private addSettingsPage: (title: string, node: HTMLElement) => () => void,
    private registerCommand: (command: ComposerCommand) => () => void) {}
  async enable(plugin: FrontendPlugin, config: Record<string, unknown> = {}) {
    this.disable(plugin.id);
    const cleanup: (() => void)[] = [];
    this.mounted.set(plugin.id, cleanup);
    try {
      const dispose = await plugin.setup({ ...this.services,
        inspect: (title, content) => { this.services.inspect(title, content); cleanup.push(() => content.remove()); },
        config: Object.freeze(structuredClone(config)),
        mount: (slot, node) => { this.slots[slot].append(node); cleanup.push(() => node.remove()); },
        command: (command) => cleanup.push(this.registerCommand(command)),
        settingsPage: (title, node) => cleanup.push(this.addSettingsPage(title, node)),
        tool: (name, render) => {
          if (this.renderers.has(name)) throw new Error('Duplicate tool renderer: ' + name);
          this.renderers.set(name, { owner: plugin.id, render });
          cleanup.push(() => this.renderers.delete(name));
        },
        onDispose: (fn) => cleanup.push(fn)
      });
      if (dispose) cleanup.push(dispose);
    } catch (error) { this.disable(plugin.id); throw error; }
  }
  disable(id: string) {
    const cleanup = this.mounted.get(id);
    this.mounted.delete(id);
    for (const dispose of cleanup?.reverse() ?? []) { try { dispose(); } catch (error) { this.report(error); } }
  }
  render(tool: ToolView) {
    try { return this.renderers.get(tool.name)?.render(tool); }
    catch (error) { this.report(error); }
  }
  clear() { for (const id of [...this.mounted.keys()].reverse()) this.disable(id); }
}
