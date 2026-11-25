import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { SessionRecord } from './shared/identity.ts';
import type { WorkspacePort } from '@mini-harness/workspaces/api';
import { readJson } from '@mini-harness/platform/json';

export type StoredSession = Pick<SessionRecord, 'id' | 'workspaceId'>;
export interface CatalogState {
  sessions: SessionRecord[];
  pendingDelete?: StoredSession[];
}

/** The catalog owns conversation identity; every log lives under the managed session directory. */
export function loadCatalog(paths: Paths, workspaces: WorkspacePort): CatalogState {
  const saved = readJson<Partial<CatalogState> | null>(paths.registry, { sessions: [] });
  if (!saved || !Array.isArray(saved.sessions)) throw new Error('Invalid conversation index');
  if (saved.pendingDelete !== undefined && !Array.isArray(saved.pendingDelete))
    throw new Error('Invalid deletion journal');
  validateCatalog(saved.sessions, workspaces);
  return { sessions: saved.sessions, ...(saved.pendingDelete ? { pendingDelete: saved.pendingDelete } : {}) };
}

export function validateCatalog(sessions: SessionRecord[], workspaces: WorkspacePort) {
  const records = new Map<string, SessionRecord>();
  for (const record of sessions) {
    if (
      record?.permission !== undefined &&
      record.permission !== 'standard' &&
      record.permission !== 'readOnly' &&
      record.permission !== 'fullAccess'
    )
      throw new Error('Invalid conversation permission');
    if (
      !record ||
      !/^[a-f0-9-]{36}$/i.test(record.id) ||
      records.has(record.id) ||
      (record.workspaceId !== null && typeof record.workspaceId !== 'string') ||
      typeof record.title !== 'string' ||
      !['auto', 'manual'].includes(record.titleSource) ||
      !Number.isFinite(Date.parse(record.createdAt))
    )
      throw new Error('Invalid conversation index');
    if (record.workspaceId !== null) workspaces.get(record.workspaceId);
    records.set(record.id, record);
  }
  for (const record of sessions) {
    const ancestors = new Set([record.id]);
    for (let item = record; item.parentId; ) {
      const parent = records.get(item.parentId);
      if (!parent || parent.workspaceId !== record.workspaceId || ancestors.has(parent.id))
        throw new Error('Invalid conversation ancestry');
      ancestors.add(parent.id);
      item = parent;
    }
  }
}
