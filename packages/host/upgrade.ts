import type { Paths } from '../contracts/config.js';
import type { SessionRecord } from '../contracts/conversation.js';
import type { RunInfo } from '../contracts/transport.js';
import { join } from 'node:path';
import { readJson, writeJson } from '../platform/config.js';

type OldRecord = Omit<SessionRecord, 'piSessionRef' | 'titleSource'> & { file: string | null; run?: RunInfo };
type OldJournal = { workspaceId: string; file: string | null };

/** This upgrade is repeatable after a crash and completes before either owner is mounted. */
export function upgrade(paths: Paths) {
  const index = readJson<{ version?: number; sessions: OldRecord[]; pendingDelete?: OldJournal[] }>(paths.registry, null);
  if (!index || index.version === 2) return;
  if (index.version !== undefined || !Array.isArray(index.sessions) || index.sessions.some(({ workspaceId }) => typeof workspaceId !== 'string'))
    throw new Error('Invalid conversation index');
  const file = join(paths.home, 'runs.json');
  const previous = readJson<Record<string, RunInfo>>(file, {});
  const runs = Object.fromEntries(index.sessions.flatMap(({ id, run }) => run ? [[id, run]] : []));
  if (Object.keys(runs).length) writeJson(file, { ...runs, ...previous });
  const sessions: SessionRecord[] = index.sessions.map(({ id, workspaceId, parentId, title, createdAt, file }) => ({
    id, workspaceId, parentId, title, createdAt, titleSource: title === 'New conversation' ? 'auto' : 'manual', piSessionRef: file ?? null
  }));
  const pendingDelete = index.pendingDelete?.map(({ workspaceId, file }) => ({ workspaceId, piSessionRef: file }));
  writeJson(paths.registry, { version: 2, sessions, pendingDelete });
}
