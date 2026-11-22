import type { Conversation } from '../src/registry.js';
import type { WorkspaceRecord } from '../src/workspace-catalog.js';
import type { NavigationEvent } from '../src/navigation-events.js';
import type { BrowserState } from './client.js';
import type { FrontendApi } from './extensions.js';
import { api as request, readEvents, scopedElements, payload } from './api.js';
import { sessionTree } from './sessions.js';
import { button, dialog, field, fromMarkup, iconButton } from './primitives.js';
import { fileLabel } from './icons.js';

interface NavigationServices {
  state: BrowserState;
  activate(id: string): void;
  select(id: string, draft?: boolean): void;
  chooseWorkspace(onAdd: (record: WorkspaceRecord) => void): void;
  manageWorkspace(record: WorkspaceRecord): void;
  clearConversation(): void;
  report(error: Error): void;
  changed(): void;
  setTitle(title: string): void;
}

function workspacePath(path: string) {
  return /^(?:[a-z]:|\\\\)/i.test(path) ? path.replaceAll('\\', '/').toLowerCase() : path;
}

export function sessionNavigation(api: FrontendApi, options: NavigationServices) {
  const { state } = options;
  const panel = fromMarkup(`<div class="session-navigation">
    <div class="sidebar-caption">
      <span>Workspaces</span>
      <div id="workspaceActions"><button id="selectMode" class="link-button" type="button" aria-pressed="false">Select</button></div>
    </div>
    <input id="sessionSearch" class="ui-input" type="search" placeholder="Search workspaces and conversations" aria-label="Search workspaces and conversations">
    <nav id="sessions" class="sessions" aria-label="Conversation tree"></nav>
    <div id="bulkActions" class="bulk-actions" hidden>
      <span id="selectedCount" aria-live="polite"></span>
    </div>
  </div>`);
  api.mount('session-navigation', panel);
  const { element, value } = scopedElements(panel);
  const title = document.createElement('input');
  title.required = true;
  title.maxLength = 140;
  const renameForm = document.createElement('form');
  renameForm.className = 'workspace-form';
  const status = document.createElement('p');
  status.className = 'form-error';
  status.setAttribute('role', 'status');
  const save = button('Rename', 'primary');
  save.type = 'submit';
  renameForm.append(field('Title', title), status, save);
  const renameDialog = dialog('Rename conversation', renameForm);
  api.mount('dialogs', renameDialog);
  let renaming: string;
  const selection = new Set<string>(), expanded = new Set<string>();
  const storageKey = 'mini-harness-collapsed-workspaces';
  const collapsed = new Set<string>(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));
  let selecting = false;
  let visible: Conversation[] = [];
  const selectAll = button('Select all');
  const exportButton = button('Export');
  const deleteButton = button('Delete', 'danger');
  const cancel = button('Cancel', 'quiet');
  element('bulkActions').append(selectAll, exportButton, deleteButton, cancel);
  const addWorkspace = iconButton('Add workspace', 'plus');
  element('workspaceActions').append(addWorkspace);
  addWorkspace.onclick = () => options.chooseWorkspace((record) => {
    if (!state.get().workspaces.some(({ id }) => id === record.id)) state.get().workspaces.push(record);
    revealWorkspace(record.id);
    options.select(record.id);
  });

  async function exportSessions(ids: string[]) {
    const response = await request('/sessions/export', { ...payload('POST', { ids }), signal: api.signal });
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mini-harness-sessions.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function remove(ids: string[]) {
    const result = await api.request<{ deleted: string[] }>('/sessions/delete', payload('POST', { ids }));
    for (const id of result.deleted) apply({ type: 'delete', id });
  }

  function rename(item: Conversation) {
    renaming = item.id;
    title.value = item.title;
    status.textContent = '';
    renameDialog.showModal();
    title.select();
  }
  renameForm.onsubmit = async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try {
      await api.request('/sessions/' + renaming, payload('PATCH', { title: title.value }));
      renameDialog.close();
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  };

  function selectionChanged() {
    element('selectMode').setAttribute('aria-pressed', String(selecting));
    element('bulkActions').hidden = !selecting;
    element('selectedCount').textContent = selection.size + ' selected';
    exportButton.disabled = deleteButton.disabled = !selection.size;
    selectAll.disabled = !visible.length;
  }

  function toggleSelection(value: boolean) {
    selecting = value;
    selection.clear();
    render();
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
  const rememberCollapsed = () => localStorage.setItem(storageKey, JSON.stringify([...collapsed]));
  function revealWorkspace(id: string) {
    const parents = hierarchy(state.get().workspaces);
    for (let cursor = id; cursor; cursor = parents.get(cursor)) collapsed.delete(cursor);
    rememberCollapsed();
  }

  function render() {
    const { sessions, workspaces } = state.get();
    const query = value('sessionSearch').toLowerCase();
    const container = element('sessions');
    const focus = container.contains(document.activeElement) ? document.activeElement.id : '';
    const scroll = container.scrollTop;
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
    visible = [];
    function workspaceBranch(parent?: string) {
      const list = document.createElement('ul');
      list.className = 'workspace-branch';
      for (const record of children.get(parent) ?? []) {
        const { id, name, path } = record;
        const matches = !query || name.toLowerCase().includes(query) || path.toLowerCase().includes(query);
        const current = state.selectedWorkspace === id;
        const tree = sessionTree(grouped.get(id) ?? [], {
          active: state.activeConversation, expanded, selection, selecting, query: matches ? '' : query,
          render, selectionChanged, activate: options.activate, rename,
          remove(item) {
            if (confirm('Permanently delete "' + item.title + '" and all child conversations?'))
              void remove([item.id]).catch(options.report);
          }
        });
        const branches = workspaceBranch(id);
        if (!matches && !tree.visible.length && !branches.childElementCount) continue;
        visible.push(...tree.visible);
        const open = !collapsed.has(id) || Boolean(query);
        const row = document.createElement('div');
        row.className = 'workspace-row';
        const toggle = iconButton((open ? 'Collapse workspace ' : 'Expand workspace ') + name, 'chevron', 'tree-button');
        toggle.id = 'workspace-toggle-' + id;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.onclick = () => {
          if (open) collapsed.add(id);
          else collapsed.delete(id);
          rememberCollapsed();
          render();
        };
        const chooser = button('', 'quiet');
        chooser.classList.add('workspace-name');
        chooser.id = 'workspace-name-' + id;
        chooser.title = path;
        if (current) chooser.setAttribute('aria-current', 'location');
        fileLabel(chooser, name, open ? 'folder-open' : 'folder');
        if (labels.get(name) > 1) {
          const shortPath = document.createElement('small');
          shortPath.textContent = path.split(/[/\\]/).filter(Boolean).slice(-3).join('/');
          chooser.append(shortPath);
        }
        chooser.onclick = () => { revealWorkspace(id); options.select(id); };
        const actions = document.createElement('div');
        actions.className = 'workspace-actions';
        const create = iconButton('New in ' + name, 'plus');
        create.id = 'workspace-new-' + id;
        create.onclick = () => { revealWorkspace(id); options.select(id, true); };
        const manage = iconButton('Manage ' + name, 'settings');
        manage.id = 'workspace-manage-' + id;
        manage.onclick = () => options.manageWorkspace(record);
        actions.append(create, manage);
        row.append(toggle, chooser, actions);
        const entry = document.createElement('li');
        entry.append(row);
        if (open) entry.append(tree.list, branches);
        list.append(entry);
      }
      return list;
    }
    container.replaceChildren(workspaceBranch());
    if (!container.firstElementChild.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'hint workspace-empty';
      empty.textContent = query ? 'No matches' : 'Add a workspace to start a conversation.';
      container.append(empty);
    }
    container.scrollTop = scroll;
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
    selectionChanged();
  }

  function apply(event: NavigationEvent) {
    const snapshot = state.get();
    switch (event.type) {
      case 'snapshot':
        snapshot.workspaces = event.workspaces;
        snapshot.sessions = event.sessions;
        break;
      case 'workspaces': snapshot.workspaces = event.workspaces; break;
      case 'delete': snapshot.sessions = snapshot.sessions.filter(({ id }) => id !== event.id); break;
      case 'session': {
        const { session } = event;
        const index = snapshot.sessions.findIndex(({ id }) => id === session.id);
        if (index >= 0) snapshot.sessions[index] = session;
        else snapshot.sessions.unshift(session);
        snapshot.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        break;
      }
    }
    state.reconcileWorkspace();
    const registered = new Set(snapshot.workspaces.map(({ id }) => id));
    const sessions = new Set(snapshot.sessions.filter(({ workspaceId }) => registered.has(workspaceId)).map(({ id }) => id));
    for (const id of selection) if (!sessions.has(id)) selection.delete(id);
    if (state.activeConversation) {
      const active = snapshot.sessions.find(({ id }) => id === state.activeConversation);
      if (!active || !registered.has(active.workspaceId)) options.clearConversation();
      else options.setTitle(active.title);
    }
    render();
    options.changed();
  }

  async function subscribe() {
    let delay = 300;
    while (!api.signal.aborted) {
      try {
        const response = await request('/navigation/events', { signal: api.signal });
        await readEvents<NavigationEvent>(response, (event) => { delay = 300; apply(event); });
      } catch { /* The next connection starts with the current snapshot. */ }
      if (api.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); api.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delay);
        api.signal.addEventListener('abort', finish, { once: true });
      });
      delay = Math.min(delay * 2, 5000);
    }
  }

  element('selectMode').onclick = () => toggleSelection(!selecting);
  element('sessionSearch').oninput = render;
  cancel.onclick = () => toggleSelection(false);
  selectAll.onclick = () => { for (const item of visible) selection.add(item.id); render(); };
  exportButton.onclick = () => void exportSessions([...selection]).catch(options.report);
  deleteButton.onclick = () => {
    if (confirm('Permanently delete ' + selection.size + ' selected conversations and their descendants?'))
      void remove([...selection]).then(() => toggleSelection(false)).catch(options.report);
  };

  render();
  void subscribe();
  return {
    render, export: exportSessions,
    add(item: Conversation) {
      if (!state.get().sessions.some(({ id }) => id === item.id)) apply({ type: 'session', session: item });
    },
    session(id: string) { return state.get().sessions.find((item) => item.id === id); },
    reveal(item: Conversation, workspace: boolean) {
      if (workspace) revealWorkspace(item.workspaceId);
      for (let parent = item.parentId; parent && !expanded.has(parent); parent = state.get().sessions.find(({ id }) => id === parent)?.parentId) expanded.add(parent);
    }
  };
}
