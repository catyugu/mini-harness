import type { Conversation } from '../../contracts/conversation.js';
import type { WorkspaceRecord } from '../../contracts/workspace.js';

function workspacePath(path: string) {
  return /^(?:[a-z]:|\\\\)/i.test(path) ? path.replaceAll('\\', '/').toLowerCase() : path;
}

function hierarchy(workspaces: WorkspaceRecord[]) {
  const paths = new Map(workspaces.map((record) => [record.id, workspacePath(record.path)]));
  const parents = new Map<string, string>();
  for (const record of workspaces) {
    const path = paths.get(record.id);
    let parent: WorkspaceRecord;
    for (const candidate of workspaces) {
      const root = paths.get(candidate.id);
      if (candidate.id !== record.id && path.startsWith(root.endsWith('/') ? root : root + '/') &&
          (!parent || root.length > paths.get(parent.id).length)) parent = candidate;
    }
    if (parent) parents.set(record.id, parent.id);
  }
  return parents;
}
export function workspaceTree(workspaces: WorkspaceRecord[], sessions: Conversation[] = []) {
  const parents = hierarchy(workspaces);
  const children = new Map<string, WorkspaceRecord[]>();
  for (const record of workspaces) {
    const parent = parents.get(record.id);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(record);
  }
  const grouped = new Map<string, Conversation[]>();
  for (const session of sessions) {
    if (!grouped.has(session.workspaceId)) grouped.set(session.workspaceId, []);
    grouped.get(session.workspaceId).push(session);
  }
  const labels = new Map<string, number>();
  for (const { name } of workspaces) labels.set(name, (labels.get(name) ?? 0) + 1);
  return { parents, children, grouped, labels };
}

export function sessionHierarchy(sessions: Conversation[], query: string) {
  const byId = new Map(sessions.map((item) => [item.id, item]));
  const included = new Set<string>();
  for (const item of sessions) if (!query || item.title.toLowerCase().includes(query)) {
    for (let id: string | null = item.id; id && !included.has(id); id = byId.get(id)?.parentId) included.add(id);
  }
  const visible = sessions.filter((item) => included.has(item.id));
  const children = new Map<string | null, Conversation[]>();
  for (const item of visible) {
    const parent = byId.has(item.parentId) ? item.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }

  return { children, visible };
}
