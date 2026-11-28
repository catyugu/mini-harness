import type { TaskHandle } from '@mini-harness/tasks/api';
import { isRunning, type RunInfo } from './shared/run-state.ts';
import {
  updateRecords,
  updateTools,
  type LiveRecord,
  type RunEvent,
  type StreamEvent,
  type ToolProgress,
} from './shared/stream.ts';

export class RunEvents {
  private events: RunEvent[] = [];
  private bytes = 0;
  private listeners = new Map<(event: RunEvent) => void, () => void>();
  private tools: ToolProgress[] = [];
  partial = '';
  private records: LiveRecord[] = [];

  get activeRecords() {
    return this.records;
  }

  readonly handle: TaskHandle<string>;
  writeError?: Error;

  constructor(
    readonly info: RunInfo,
    task: TaskHandle<string>,
  ) {
    this.handle = {
      ...task,
      result: task.result.finally(() => {
        if (this.writeError) throw this.writeError;
      }),
    };
  }

  get activeTools() {
    return this.tools;
  }

  publish(event: StreamEvent) {
    if (event.type === 'record-update') {
      if (event.operation === 'set') event = { ...event, record: { ...event.record, runId: this.info.id } };
      this.records = updateRecords(this.records, event);
    }
    if (event.type === 'branch') {
      const records = event.records.map((record) => ({ ...record, runId: this.info.id }));
      const ids = new Set(records.map(({ id }) => id));
      event = { ...event, records };
      this.records = this.records.filter(({ id }) => !ids.has(id));
    }
    if (event.type === 'assistant-start' || event.type === 'assistant-end') this.partial = '';
    if (event.type === 'assistant-end') this.info.answerEntryId = event.message.id;
    if (event.type === 'delta') this.partial += event.text;
    if (event.type === 'tool' || event.type === 'tool-output' || event.type === 'tool-end')
      this.tools = updateTools(this.tools, event);
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
