import { isRunning, type RunInfo } from '@mini-harness/sessions/run-state';
import type { RunEvent, StreamEvent, ToolProgress } from './stream.ts';
import { updateRecords, type SessionDisplayRecord } from '@mini-harness/sessions/display-record';

export class RunEvents {
  private events: RunEvent[] = [];
  private bytes = 0;
  private listeners = new Map<(event: RunEvent) => void, () => void>();
  private tools = new Map<string, ToolProgress>();
  partial = '';
  private records: SessionDisplayRecord[] = [];

  get activeRecords() {
    return this.records;
  }

  constructor(readonly info: RunInfo) {}

  get activeTools() {
    return [...this.tools.values()];
  }

  publish(event: StreamEvent) {
    if (event.type === 'record-update') {
      if (event.operation === 'set') event = { ...event, record: { ...event.record, runId: this.info.id } };
      this.records = updateRecords(this.records, event);
    }
    if (event.type === 'branch' && event.display) {
      const display = { ...event.display, runId: this.info.id };
      event = { ...event, display };
      this.records = this.records.filter((record) => record.id !== display.id);
    }
    if (event.type === 'assistant-start' || event.type === 'assistant-end') this.partial = '';
    if (event.type === 'delta') this.partial += event.text;
    if (event.type === 'tool') this.tools.set(event.id, event);
    if (event.type === 'tool-end') this.tools.delete(event.message.toolCallId);
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
      'timeline' | 'model' | 'thinkingLevel' | 'leafId'
    >,
    end = () => {},
  ) {
    if (after < (this.events[0]?.sequence ?? 1) - 1) {
      emit({
        type: 'snapshot',
        ...history(),
        partial: this.partial,
        tools: this.activeTools,
        records: this.activeRecords,
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
