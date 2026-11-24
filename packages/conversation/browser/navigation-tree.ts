import type { Conversation } from '../view.js';
import type { WorkspaceRecord } from '@mini-harness/workspaces/api';

function workspacePath(path: string) {
  return /^(?:[a-z]:|\\\\)/i.test(path) ? path.replaceAll('\\', '/').toLowerCase() : path;
}

function hierarchy(workspaces: WorkspaceRecord[]) {
  const paths = new Map(workspaces.map((record) => [record.id, workspacePath(record.path)]));
  const parents = new Map<string, string>();
  for (const record of workspaces) {
    const path = paths.get(record.id);
    if (path === undefined) throw new Error('Workspace normalization lost an entry');
    let parent: WorkspaceRecord | undefined;
    let longestPrefix = -1;
    for (const candidate of workspaces) {
      const root = paths.get(candidate.id);
      if (root === undefined || candidate.id === record.id) continue;
      if (path.startsWith(root.endsWith('/') ? root : root + '/') && root.length > longestPrefix) {
        parent = candidate;
        longestPrefix = root.length;
      }
    }
    if (parent) parents.set(record.id, parent.id);
  }
  return parents;
}
export function workspaceTree(workspaces: WorkspaceRecord[], sessions: Conversation[] = []) {
  const parents = hierarchy(workspaces);
  const children = new Map<string | undefined, WorkspaceRecord[]>();
  for (const record of workspaces) {
    const parent = parents.get(record.id);
    const group = children.get(parent) ?? [];
    group.push(record);
    children.set(parent, group);
  }
  const grouped = new Map<string, Conversation[]>();
  for (const session of sessions) {
    const group = grouped.get(session.workspaceId) ?? [];
    group.push(session);
    grouped.set(session.workspaceId, group);
  }
  const labels = new Map<string, number>();
  for (const { name } of workspaces) labels.set(name, (labels.get(name) ?? 0) + 1);
  return { parents, children, grouped, labels };
}

export function sessionHierarchy(sessions: Conversation[], query: string, matches?: { has(id: string): boolean }) {
  const byId = new Map(sessions.map((item) => [item.id, item]));
  const included = new Set<string>();
  for (const item of sessions) if (!query || item.title.toLowerCase().includes(query) || matches?.has(item.id)) {
    for (let id: string | null = item.id; id && !included.has(id); id = byId.get(id)?.parentId ?? null) included.add(id);
  }
  const visible = sessions.filter((item) => included.has(item.id));
  const children = new Map<string | null, Conversation[]>();
  for (const item of visible) {
    const parent = item.parentId && byId.has(item.parentId) ? item.parentId : null;
    const group = children.get(parent) ?? [];
    group.push(item);
    children.set(parent, group);
  }

  return { children, visible };
}
