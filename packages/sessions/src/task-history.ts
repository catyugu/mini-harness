import { terminal, type TaskSnapshot } from '@mini-harness/tasks/api';
import { readTaskOutput } from '@mini-harness/tasks/output';
import type { SessionEntry } from './log-api.ts';

type TaskEntry = Extract<SessionEntry, { type: 'task' }>;
type MessageEntry = Extract<SessionEntry, { type: 'message' }>;

interface IndexedTask {
  entry: TaskEntry;
  queuedAt?: number;
  answer?: MessageEntry;
}

/** References to committed log entries, retained when the writer is closed. */
export class TaskHistory {
  private readonly tasks = new Map<string, IndexedTask>();
  private assistant?: MessageEntry;

  add(entry: SessionEntry) {
    if (entry.type === 'message' && entry.message.role === 'assistant') this.assistant = entry;
    if (entry.type !== 'task') return;
    const { task, run, seq } = entry;
    const queuedAt = this.tasks.get(task.id)?.queuedAt ?? (task.state === 'queued' ? seq : undefined);
    const answer =
      run &&
      task.state === 'completed' &&
      queuedAt !== undefined &&
      this.assistant &&
      this.assistant.seq > queuedAt
        ? this.assistant
        : undefined;
    this.tasks.set(task.id, { entry, queuedAt, answer });
  }

  get ids() {
    return this.tasks.keys();
  }

  get entries() {
    return Array.from(this.tasks.values(), ({ entry }) => entry);
  }

  summaries(type?: string, limit = Infinity, exclude?: ReadonlySet<string>): Omit<TaskSnapshot, 'result'>[] {
    const tasks = this.entries
      .map(({ task }) => task)
      .filter((task) => (type === undefined || task.type === type) && !exclude?.has(task.id));
    if (limit !== Infinity) tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).splice(limit);
    return tasks.map(({ result: _, ...task }) => structuredClone(task));
  }

  summary(id: string): Omit<TaskSnapshot, 'result'> | undefined {
    const entry = this.tasks.get(id)?.entry;
    if (!entry) return;
    const { result: _, ...task } = entry.task;
    return structuredClone(task);
  }

  detail(id: string): TaskSnapshot | undefined {
    const indexed = this.tasks.get(id);
    if (!indexed) return;
    const {
      entry: { task, run },
      answer,
    } = indexed;
    const result =
      answer?.message.role === 'assistant'
        ? answer.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
        : undefined;
    if (!terminal(task.state))
      return structuredClone({
        ...task,
        state: 'interrupted',
        error: 'No live executor remains for this task',
      });
    return structuredClone(run && task.state === 'completed' ? { ...task, result } : task);
  }

  output(id: string, after?: number) {
    const entry = this.tasks.get(id)?.entry;
    if (entry)
      return readTaskOutput(
        entry.output ?? { cursor: entry.task.outputCursor, truncated: false, chunks: [] },
        after,
      );
  }
}
