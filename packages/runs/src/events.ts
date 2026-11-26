import { isRunning, type RunInfo } from '@mini-harness/sessions/run-state';
import type { RunEvent, StreamEvent } from './stream.ts';

export class RunEvents {
  private events: RunEvent[] = [];
  private bytes = 0;
  private listeners = new Map<(event: RunEvent) => void, () => void>();
  private tools = new Map<string, Extract<StreamEvent, { type: 'tool' }>>();
  partial = '';

  constructor(readonly info: RunInfo) {}

  get activeTools() {
    return [...this.tools.values()];
  }

  publish(event: StreamEvent) {
    if (event.type === 'assistant-start' || event.type === 'assistant-end') this.partial = '';
    if (event.type === 'delta') this.partial += event.text;
    if (event.type === 'tool') {
      if (event.state === 'running' || event.state === 'approval') this.tools.set(event.id, event);
      else this.tools.delete(event.id);
    }
    const item: RunEvent = {
      ...event,
      runId: this.info.id,
      runSessionId: this.info.sessionId,
      sequence: ++this.info.sequence,
    };
    this.events.push(item);
    this.bytes += JSON.stringify(item).length;
    while (this.events.length > 2048 || (this.bytes > 1024 * 1024 && this.events.length > 1))
      this.bytes -= JSON.stringify(this.events.shift()).length;
    for (const listener of this.listeners.keys()) {
      try {
        listener(structuredClone(item));
      } catch {
        this.listeners.delete(listener);
      }
    }
    return item;
  }

  watch(
    after: number,
    emit: (event: RunEvent) => void,
    history: () => Pick<
      Extract<StreamEvent, { type: 'snapshot' }>,
      'messages' | 'records' | 'terminations' | 'model' | 'thinkingLevel' | 'leafId'
    >,
    end = () => {},
  ) {
    if (after < (this.events[0]?.sequence ?? 1) - 1) {
      emit({
        type: 'snapshot',
        ...history(),
        partial: this.partial,
        tools: this.activeTools,
        run: { ...this.info },
        sequence: this.info.sequence,
        runId: this.info.id,
        runSessionId: this.info.sessionId,
      });
    } else {
      for (const event of this.events) if (event.sequence > after) emit(structuredClone(event));
    }
    if (isRunning(this.info)) this.listeners.set(emit, end);
    return () => {
      this.listeners.delete(emit);
    };
  }

  close() {
    const remaining = [...this.listeners.values()];
    this.listeners.clear();
    for (const end of remaining) end();
  }
}
