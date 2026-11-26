import { KeyedRegistry } from '@mini-harness/ui-runtime/keyed-registry';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type {
  MessageAction,
  RecordRenderer,
  ToolRenderer,
  ToolView,
  TurnFooterRenderer,
} from '../history-api.ts';

export class MessageExtensions {
  private readonly actions = new Map<string, MessageAction>();
  private readonly renderers = new KeyedRegistry<string, ToolRenderer>();
  private readonly toolActions = new KeyedRegistry<string, ToolRenderer>();
  private readonly records = new KeyedRegistry<string, RecordRenderer>();
  private readonly footers = new Map<string, TurnFooterRenderer>();
  private readonly events = new EventTarget();

  readonly report = (error: unknown) => console.error('Conversation extension failed', error);

  private replace<T>(
    registry: KeyedRegistry<string, T>,
    key: string,
    value: T,
    event: string,
    priority: number,
  ) {
    const remove = registry.add(key, value, priority);
    const change = () => this.events.dispatchEvent(new CustomEvent(event, { detail: key }));
    change();
    return () => {
      const selected = registry.get(key);
      remove();
      if (selected !== registry.get(key)) change();
    };
  }

  registerRecord(plugin: string, render: RecordRenderer, priority = 0) {
    return this.replace(this.records, plugin, render, 'records', priority);
  }

  subscribeToRecords(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('records', listener, { signal });
  }

  recordRenderer(plugin: string) {
    return this.records.get(plugin);
  }

  private renderWithLifetime(parent: AbortSignal, render: (signal: AbortSignal) => HTMLElement | undefined) {
    const lifetime = new AbortController();
    try {
      const node = render(AbortSignal.any([parent, lifetime.signal]));
      if (node) return node;
    } catch (error) {
      this.report(error);
    }
    lifetime.abort();
  }

  renderRecord(
    render: RecordRenderer | undefined,
    record: SessionDisplayRecord,
    context: { sessionId: string; signal: AbortSignal },
  ) {
    if (render)
      return this.renderWithLifetime(context.signal, (signal) =>
        render(structuredClone(record), { ...context, signal }),
      );
  }

  registerTurnFooter(id: string, render: TurnFooterRenderer) {
    if (this.footers.has(id)) throw new Error('Duplicate turn footer: ' + id);
    this.footers.set(id, render);
    this.events.dispatchEvent(new Event('footers'));
    return () => {
      this.footers.delete(id);
      this.events.dispatchEvent(new Event('footers'));
    };
  }

  turnFooters() {
    return this.footers.values();
  }

  subscribeToFooters(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('footers', listener, { signal });
  }

  actionsForMessage() {
    return [...this.actions.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  subscribe(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('change', listener, { signal });
  }

  registerAction(action: MessageAction) {
    if (this.actions.has(action.id)) throw new Error('Duplicate message action: ' + action.id);
    this.actions.set(action.id, action);
    this.events.dispatchEvent(new Event('change'));
    return () => {
      this.actions.delete(action.id);
      this.events.dispatchEvent(new Event('change'));
    };
  }

  registerTool(name: string, render: ToolRenderer, action = false, priority = 0) {
    const registry = action ? this.toolActions : this.renderers;
    return this.replace(registry, name, render, 'tools', priority);
  }

  subscribeToTools(listener: (name: string) => void, signal: AbortSignal) {
    this.events.addEventListener(
      'tools',
      (event) => {
        if (event instanceof CustomEvent && typeof event.detail === 'string') listener(event.detail);
      },
      { signal },
    );
  }

  render(tool: ToolView, signal: AbortSignal, action = false) {
    const render = (action ? this.toolActions : this.renderers).get(tool.name);
    if (render) return this.renderWithLifetime(signal, (lifetime) => render(tool, lifetime));
  }
}
