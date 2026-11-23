import { readJson, writeJson } from '../platform/config.js';
import { isRunning, type RunInfo } from '../contracts/transport.js';

export class Checkpoints {
  private records: Record<string, RunInfo>;

  constructor(private readonly file: string, exists: (id: string) => boolean) {
    const saved = readJson<Record<string, RunInfo>>(file, {});
    this.records = Object.fromEntries(Object.entries(saved).flatMap(([id, run]) => {
      if (!exists(id)) return [];
      if (isRunning(run)) return [[id, { ...run, state: 'interrupted', finishedAt: new Date().toISOString(),
        error: 'Server stopped before the run finished' }]];
      return [[id, run]];
    }));
    if (Object.keys(this.records).length !== Object.keys(saved).length || Object.values(saved).some(isRunning))
      writeJson(file, this.records);
  }

  get(id: string) { return this.records[id]; }

  save(run: RunInfo) {
    const next = { ...this.records, [run.sessionId]: structuredClone(run) };
    writeJson(this.file, next);
    this.records = next;
  }

  remove(id: string) {
    if (!Object.hasOwn(this.records, id)) return;
    const next = { ...this.records };
    delete next[id];
    writeJson(this.file, next);
    this.records = next;
  }
}
