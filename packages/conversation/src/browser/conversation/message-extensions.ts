import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageAction, RecordRenderer, ToolView } from '../composer-api.js';

export class MessageExtensions {
  private readonly actions = new Map<string, MessageAction>();
  private readonly renderers = new Map<string, ((tool: ToolView) => HTMLElement | undefined)[]>();
  private readonly toolActions = new Map<string, ((tool: ToolView) => HTMLElement | undefined)[]>();
  private readonly records = new Map<string, RecordRenderer[]>();
  private readonly events = new EventTarget();

  constructor(private readonly report: (error: Error) => void) {}

  private replace<T>(registry: Map<string, T[]>, key: string, value: T, event: string) {
    const stack = registry.get(key) ?? [];
    registry.set(key, stack);
    stack.push(value);
    this.events.dispatchEvent(new Event(event));
    return () => {
      stack.splice(stack.indexOf(value), 1);
      if (!stack.length) registry.delete(key);
      this.events.dispatchEvent(new Event(event));
    };
  }

  registerRecord(plugin: string, render: RecordRenderer) {
    return this.replace(this.records, plugin, render, 'records');
  }

  subscribeToRecords(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('records', listener, { signal });
  }

  renderRecord(record: SessionDisplayRecord, context: { sessionId: string; signal: AbortSignal }) {
    try { return this.records.get(record.plugin)?.at(-1)?.(structuredClone(record), context); }
    catch (error) { this.report(error instanceof Error ? error : new Error(String(error))); }
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

  registerTool(name: string, render: (tool: ToolView) => HTMLElement | undefined, action = false) {
    const registry = action ? this.toolActions : this.renderers;
    return this.replace(registry, name, render, 'tools');
  }

  subscribeToTools(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('tools', listener, { signal });
  }

  render(tool: ToolView, action = false) {
    try { return (action ? this.toolActions : this.renderers).get(tool.name)?.at(-1)?.(tool); }
    catch (error) { this.report(error instanceof Error ? error : new Error(String(error))); }
  }
}
