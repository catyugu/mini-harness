import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageAction, RecordRenderer, ToolView } from '../composer-api.js';

export class MessageExtensions {
  private readonly actions = new Map<string, MessageAction>();
  private readonly renderers = new Map<string, (tool: ToolView) => HTMLElement | undefined>();
  private readonly toolActions = new Map<string, (tool: ToolView) => HTMLElement | undefined>();
  private readonly records = new Map<string, RecordRenderer[]>();
  private readonly events = new EventTarget();

  constructor(private readonly report: (error: Error) => void) {}

  registerRecord(plugin: string, render: RecordRenderer) {
    const stack = this.records.get(plugin) ?? [];
    this.records.set(plugin, stack);
    stack.push(render);
    this.events.dispatchEvent(new Event('records'));
    return () => {
      stack.splice(stack.indexOf(render), 1);
      if (!stack.length) this.records.delete(plugin);
      this.events.dispatchEvent(new Event('records'));
    };
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
    if (registry.has(name)) throw new Error('Duplicate tool contribution: ' + name);
    registry.set(name, render);
    this.events.dispatchEvent(new Event('tools'));
    return () => { registry.delete(name); this.events.dispatchEvent(new Event('tools')); };
  }

  subscribeToTools(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('tools', listener, { signal });
  }

  render(tool: ToolView, action = false) {
    try { return (action ? this.toolActions : this.renderers).get(tool.name)?.(tool); }
    catch (error) { this.report(error instanceof Error ? error : new Error(String(error))); }
  }
}
