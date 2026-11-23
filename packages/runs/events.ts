import { isRunning, type RunEvent, type RunInfo, type StreamEvent } from '@mini-harness/contracts/transport';
import type { ViewMessage } from '@mini-harness/contracts/message';

export class RunEvents {
  private events: RunEvent[] = [];
  private bytes = 0;
  private listeners = new Set<(event: RunEvent) => void>();
  private tools = new Map<string, Extract<StreamEvent, { type: 'tool' }>>();
  partial = '';

  constructor(readonly info: RunInfo) {}

  get activeTools() { return [...this.tools.values()]; }

  publish(event: StreamEvent) {
    if (event.type === 'assistant-start' || event.type === 'assistant-end') this.partial = '';
    if (event.type === 'delta') this.partial += event.text;
    if (event.type === 'tool') {
      if (event.state === 'running') this.tools.set(event.id, event);
      else this.tools.delete(event.id);
    }
    const item: RunEvent = { ...event, runId: this.info.id, runSessionId: this.info.sessionId, sequence: ++this.info.sequence };
    this.events.push(item);
    this.bytes += JSON.stringify(item).length;
    while (this.events.length > 2048 || (this.bytes > 1024 * 1024 && this.events.length > 1))
      this.bytes -= JSON.stringify(this.events.shift()).length;
    for (const listener of this.listeners) {
      try { listener(structuredClone(item)); } catch { this.listeners.delete(listener); }
    }
    return item;
  }

  watch(after: number, emit: (event: RunEvent) => void, history: () => ViewMessage[]) {
    if (after < (this.events[0]?.sequence ?? 1) - 1) {
      emit({ type: 'snapshot', messages: history(), partial: this.partial, tools: this.activeTools,
        run: { ...this.info }, sequence: this.info.sequence, runId: this.info.id, runSessionId: this.info.sessionId });
    } else {
      for (const event of this.events) if (event.sequence > after) emit(structuredClone(event));
    }
    if (isRunning(this.info)) this.listeners.add(emit);
    return () => { this.listeners.delete(emit); };
  }

  close() { this.listeners.clear(); }
}
