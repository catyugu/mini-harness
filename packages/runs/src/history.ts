import type { SessionStore } from '@mini-harness/sessions/records';
import type { SessionLogReader } from '@mini-harness/sessions/log-api';
import { isRunning, type RunHistoryEntry, type RunInfo } from './shared/run-state.ts';

const owner = { pluginId: 'core:runs', instanceId: 'core:runs' };

export function runRecords(sessions: SessionStore, id: string, limit?: number) {
  return sessions.pluginRecords<RunInfo>(id, owner, limit);
}

export function recordRun(sessions: SessionStore, run: RunInfo) {
  sessions.log(run.sessionId).append({ type: 'plugin-record', owner, scope: 'session', data: run });
}

export function projectTimeline(
  log: SessionLogReader,
  records: ReturnType<typeof runRecords>,
  leafId?: string | null,
) {
  const { timeline, timelineSequences, model, thinkingLevel, leafId: leaf } = log.projection(leafId);
  const branch = new Set(log.branch(leafId).map(({ id }) => id));
  const entries: RunHistoryEntry[] = [];
  let index = 0;
  let runId: string | undefined;
  function advance(before: number) {
    for (; records[index] && records[index].seq < before; index++) {
      const { parentId, data: run } = records[index];
      runId = isRunning(run) ? run.id : undefined;
      const { id, state, error, startedAt, finishedAt } = run;
      if (
        (parentId === null || branch.has(parentId)) &&
        (state === 'failed' || state === 'cancelled' || state === 'interrupted')
      )
        entries.push({ type: 'termination', id, state, error, startedAt, finishedAt });
    }
  }
  for (const [position, entry] of timeline.entries()) {
    advance(timelineSequences[position]);
    if (runId) {
      entry.runId = runId;
      if (entry.type === 'message' && entry.role === 'assistant') delete entry.error;
    }
    entries.push(entry);
  }
  advance(Infinity);
  return { timeline: entries, leafId: leaf, model, thinkingLevel };
}

/** The last Assistant message within each run's durable interval is the stored answer. */
export function settledRuns(log: SessionLogReader, records: ReturnType<typeof runRecords>) {
  const messages = log.entries();
  let index = 0;
  let runId: string | undefined;
  let answer: string | undefined;
  return records.flatMap(({ seq, data: run }) => {
    for (; messages[index] && messages[index].seq < seq; index++) {
      const entry = messages[index];
      if (runId && entry.type === 'message' && entry.message.role === 'assistant')
        answer = entry.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
    }
    if (isRunning(run)) {
      if (runId !== run.id) answer = undefined;
      runId = run.id;
      return [];
    }
    const text = run.state === 'completed' ? answer : run.error;
    runId = undefined;
    return [{ run, answer: text }];
  });
}
