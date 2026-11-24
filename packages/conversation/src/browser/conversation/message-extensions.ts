import type { MessageAction, ToolView, BusinessRecordRenderer } from '../composer-api.js';

import type { BusinessRecord } from '../../shared/api.js';

export class MessageExtensions {
  private readonly records = new Map<string, Set<BusinessRecordRenderer>>();
  private readonly actions = new Map<string, MessageAction>();
  private readonly renderers = new Map<string, (tool: ToolView) => HTMLElement | undefined>();
  private readonly toolActions = new Map<string, (tool: ToolView) => HTMLElement | undefined>();
  private readonly events = new EventTarget();

  constructor(private readonly report: (error: Error) => void) {}

  actionsForMessage() { return [...this.actions.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }

  subscribe(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('change', listener, { signal });
  }

  registerRecord(pluginId: string, kind: string, render: BusinessRecordRenderer) {
    if (!pluginId || !kind || typeof render !== 'function') throw new Error('Invalid business record renderer');
    const key = pluginId + '/' + kind;
    let entries = this.records.get(key);
    if (!entries) this.records.set(key, entries = new Set());
    if (entries.has(render)) throw new Error('Duplicate record renderer: ' + key);
    entries.add(render);
    this.events.dispatchEvent(new Event('records'));
    return () => {
      entries.delete(render);
      if (!entries.size) this.records.delete(key);
      this.events.dispatchEvent(new Event('records'));
    };
  }

  subscribeToRecords(listener: () => void, signal: AbortSignal) {
    this.events.addEventListener('records', listener, { signal });
  }

  recordRenderer(record: BusinessRecord) {
    if (!record.presentation) return;
    return [...(this.records.get(record.pluginId + '/' + record.presentation.kind) ?? [])].at(-1);
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
