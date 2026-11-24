import { KeyedContributions } from '@mini-harness/ui-runtime/contribution';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { AttachmentPreview, MessageAction, RecordRenderer, ToolRenderer, ToolView } from '../history-api.js';

export class MessageExtensions {
  private readonly actions = new Map<string, MessageAction>();
  private readonly renderers = new KeyedContributions<string, ToolRenderer>();
  private readonly toolActions = new KeyedContributions<string, ToolRenderer>();
  private readonly records = new KeyedContributions<string, RecordRenderer>();
  private readonly events = new EventTarget();

  private attachmentPreview?: AttachmentPreview;

  registerAttachmentPreview(open: AttachmentPreview) {
    if (this.attachmentPreview) throw new Error('Duplicate attachment preview provider');
    this.attachmentPreview = open;
    return () => { this.attachmentPreview = undefined; };
  }

  openAttachment(...args: Parameters<AttachmentPreview>) {
    if (!this.attachmentPreview) return false;
    this.attachmentPreview(...args); return true;
  }

  readonly report = (error: unknown) => console.error('Conversation extension failed', error);

  private replace<T>(registry: KeyedContributions<string, T>, key: string, value: T, event: string) {
    const remove = registry.add(key, value);
    const change = () => this.events.dispatchEvent(new CustomEvent(event, { detail: key }));
    change();
    return () => {
      const selected = registry.get(key);
      remove();
      if (selected !== registry.get(key)) change();
    };
  }

  registerRecord(plugin: string, render: RecordRenderer) {
    return this.replace(this.records, plugin, render, 'records');
  }

  subscribeToRecords(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('records', listener, { signal });
  }

  recordRenderer(plugin: string) { return this.records.get(plugin); }

  private renderWithLifetime(parent: AbortSignal, render: (signal: AbortSignal) => HTMLElement | undefined) {
    const lifetime = new AbortController();
    try {
      const node = render(AbortSignal.any([parent, lifetime.signal]));
      if (node) return node;
    } catch (error) { this.report(error); }
    lifetime.abort();
  }

  renderRecord(render: RecordRenderer | undefined, record: SessionDisplayRecord, context: { sessionId: string; signal: AbortSignal }) {
    if (render) return this.renderWithLifetime(context.signal, (signal) => render(structuredClone(record), { ...context, signal }));
  }

  actionsForMessage() { return [...this.actions.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }

  subscribe(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('change', listener, { signal });
  }

  registerAction(action: MessageAction) {
    if (this.actions.has(action.id)) throw new Error('Duplicate message action: ' + action.id);
    this.actions.set(action.id, action);
    this.events.dispatchEvent(new Event('change'));
    return () => { this.actions.delete(action.id); this.events.dispatchEvent(new Event('change')); };
  }

  registerTool(name: string, render: ToolRenderer, action = false) {
    const registry = action ? this.toolActions : this.renderers;
    return this.replace(registry, name, render, 'tools');
  }

  subscribeToTools(listener: (name: string) => void, signal: AbortSignal) {
    this.events.addEventListener('tools', (event) => { if (event instanceof CustomEvent && typeof event.detail === 'string') listener(event.detail); }, { signal });
  }

  render(tool: ToolView, signal: AbortSignal, action = false) {
    const render = (action ? this.toolActions : this.renderers).get(tool.name);
    if (render) return this.renderWithLifetime(signal, (lifetime) => render(tool, lifetime));
  }
}
