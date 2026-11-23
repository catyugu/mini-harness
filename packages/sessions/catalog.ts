import type { RunInfo } from '@mini-harness/contracts/transport';
import type { Paths } from '@mini-harness/contracts/config';
import type { SessionRecord } from '@mini-harness/contracts/conversation';
import type { WorkspacePort } from '@mini-harness/contracts/services';
import { readJson } from '@mini-harness/platform/config';

export type StoredSession = Pick<SessionRecord, 'id' | 'workspaceId'>;
export interface CatalogState {
  sessions: SessionRecord[];
  pendingDelete?: StoredSession[];
  lastRuns?: Record<string, RunInfo>;
}

/** The catalog owns conversation identity; every log lives under the managed session directory. */
export function loadCatalog(paths: Paths, workspaces: WorkspacePort): CatalogState {
  const saved = readJson<Partial<CatalogState> | null>(paths.registry, { sessions: [] });
  if (!saved || !Array.isArray(saved.sessions)) throw new Error('Invalid conversation index');
  if (saved.pendingDelete !== undefined && !Array.isArray(saved.pendingDelete))
    throw new Error('Invalid deletion journal');
  validateCatalog(saved.sessions, workspaces);
  const lastRuns = Object.fromEntries(saved.sessions.flatMap(({ id }) => {
    const run = saved.lastRuns?.[id];
    return run?.sessionId === id && typeof run.id === 'string' && typeof run.startedAt === 'string' &&
      ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(run.state) ? [[id, run]] : [];
  }));
  return { sessions: saved.sessions, ...(Object.keys(lastRuns).length ? { lastRuns } : {}), ...(saved.pendingDelete ? { pendingDelete: saved.pendingDelete } : {}) };
}

export function validateCatalog(sessions: SessionRecord[], workspaces: WorkspacePort) {
  const records = new Map<string, SessionRecord>();
  for (const record of sessions) {
    if (!record || !/^[a-f0-9-]{36}$/i.test(record.id) || records.has(record.id) ||
        typeof record.workspaceId !== 'string' || typeof record.title !== 'string' ||
        !['auto', 'manual'].includes(record.titleSource) || !Number.isFinite(Date.parse(record.createdAt)))
      throw new Error('Invalid conversation index');
    workspaces.get(record.workspaceId);
    records.set(record.id, record);
  }
  for (const record of sessions) {
    const ancestors = new Set([record.id]);
    for (let item = record; item.parentId;) {
      const parent = records.get(item.parentId);
      if (!parent || parent.workspaceId !== record.workspaceId || ancestors.has(parent.id))
        throw new Error('Invalid conversation ancestry');
      ancestors.add(parent.id);
      item = parent;
    }
  }
}
