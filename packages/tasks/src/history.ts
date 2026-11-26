import type { TaskHistoryRecord, TaskSnapshot } from './api.ts';

/** A bounded observation cache, containing no executable state or handles. */
export class RecentTasks {
  private readonly records = new Map<string, { record: TaskHistoryRecord; bytes: number }>();
  private bytes = 0;

  get(id: string) {
    return this.records.get(id)?.record;
  }

  snapshots() {
    return Array.from(this.records.values(), ({ record }) => record.task);
  }

  add(record: TaskHistoryRecord) {
    const bytes = Buffer.byteLength(JSON.stringify(record));
    this.records.set(record.task.id, { record, bytes });
    this.bytes += bytes;
    const removed: TaskSnapshot[] = [];
    for (const [id, entry] of this.records) {
      if (this.records.size <= 256 && this.bytes <= 16 * 1024 * 1024) break;
      removed.push(this.delete(id, entry));
    }
    return removed;
  }

  remove(predicate: (task: TaskSnapshot) => boolean) {
    const removed: TaskSnapshot[] = [];
    for (const [id, entry] of this.records)
      if (predicate(entry.record.task)) removed.push(this.delete(id, entry));
    return removed;
  }

  private delete(id: string, { record, bytes }: { record: TaskHistoryRecord; bytes: number }) {
    this.records.delete(id);
    this.bytes -= bytes;
    return record.task;
  }
}
