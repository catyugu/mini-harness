import { KeyedRegistry } from '@mini-harness/ui-runtime/keyed-registry';
import type { LiveRecord } from '@mini-harness/runs/stream';
import type {
  MessageAction,
  RecordRenderer,
  ToolRenderer,
  ToolPlacement,
  TurnFooterRenderer,
} from '../history-api.ts';

export class MessageExtensions {
  private readonly actions = new Map<string, MessageAction>();
  private readonly tools = {
    body: new KeyedRegistry<string, ToolRenderer>(),
    action: new KeyedRegistry<string, ToolRenderer>(),
    summary: new KeyedRegistry<string, ToolRenderer>(),
    status: new KeyedRegistry<string, ToolRenderer>(),
  };
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

  registerRecord(plugin: string, kind: string, render: RecordRenderer, priority = 0) {
    return this.replace(this.records, JSON.stringify([plugin, kind]), render, 'records', priority);
  }

  subscribeToRecords(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('records', listener, { signal });
  }

  recordRenderer(plugin: string, kind: string) {
    return this.records.get(JSON.stringify([plugin, kind]));
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
    record: LiveRecord,
    context: { sessionId: string; signal: AbortSignal },
  ) {
    if (!render) return;
    const listeners = new Set<(record: LiveRecord) => void>();
    const node = this.renderWithLifetime(context.signal, (signal) => {
      signal.addEventListener('abort', () => listeners.clear(), { once: true });
      return render(structuredClone(record), {
        ...context,
        signal,
        subscribe(listener) {
          listeners.add(listener);
        },
      });
    });
    if (!node) return;
    let current = record;
    return {
      node,
      update: (next: LiveRecord) => {
        if (current === next) return;
        current = next;
        for (const listener of listeners) {
          try {
            listener(structuredClone(next));
          } catch (error) {
            this.report(error);
          }
        }
      },
    };
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

  registerTool(name: string, render: ToolRenderer, placement: ToolPlacement = 'body', priority = 0) {
    const registry = this.tools[placement];
    const prior = registry.get(name);
    const remove = registry.add(name, render, priority);
    const change = () => this.events.dispatchEvent(new CustomEvent('tools', { detail: { name, placement } }));
    if (prior !== registry.get(name)) change();
    return () => {
      const selected = registry.get(name);
      remove();
      if (selected !== registry.get(name)) change();
    };
  }

  subscribeToTools(listener: (name: string, placement: ToolPlacement) => void, signal: AbortSignal) {
    this.events.addEventListener('tools', (event) => {
      const { name, placement } = (event as CustomEvent<{ name: string; placement: ToolPlacement }>).detail;
      listener(name, placement);
    }, { signal });
  }

  toolRenderer(name: string, placement: ToolPlacement) {
    return this.tools[placement].get(name);
  }
}
