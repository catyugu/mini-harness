import type { Conversation } from '../src/registry.js';
import type { FrontendApi } from './extensions.js';
import { api as request, data, element, payload, value } from './api.js';
import { createSessionList } from './sessions.js';
import { closeOnBackdrop, fromMarkup } from './primitives.js';

interface NavigationServices {
  active(): string | undefined;
  activate(id: string): void;
  clearConversation(): void;
  report(error: Error): void;
}

export function sessionNavigation(api: FrontendApi, options: NavigationServices) {
  const panel = fromMarkup(`<div class="session-navigation">
    <div class="sidebar-caption">
      <span id="workspaceGroup">Conversations</span>
      <button id="selectMode" class="link-button" type="button" aria-pressed="false">Select</button>
    </div>
    <input id="sessionSearch" type="search" placeholder="Search conversations" aria-label="Search conversations">
    <nav id="sessions" class="sessions" aria-label="Conversation tree"></nav>
    <div id="bulkActions" class="bulk-actions" hidden>
      <span id="selectedCount" aria-live="polite"></span>
      <button id="selectAll" type="button">Select all</button>
      <button id="exportSessions" type="button">Export</button>
      <button id="deleteSessions" class="danger" type="button">Delete</button>
      <button id="cancelSelection" type="button">Cancel</button>
    </div>
  </div>`);
  api.mount('session-navigation', panel);
  const dialog = fromMarkup<HTMLDialogElement>(`
  <dialog id="renamePanel" class="workspace-panel" aria-labelledby="renameTitle">
    <header class="settings-header"><h2 id="renameTitle">Rename conversation</h2><button id="renameClose" class="icon-button" type="button" aria-label="Cancel rename" data-icon="close"></button></header>
    <form id="renameForm" class="settings-scroll"><label for="sessionTitle">Title</label><input id="sessionTitle" maxlength="140" required>
      <p id="renameStatus" class="hint" role="status"></p><button class="primary" type="submit">Rename</button>
    </form>
  </dialog>`);
  api.mount('dialogs', dialog);
  closeOnBackdrop(dialog);
  async function exportSessions(ids: string[]) {
    const response = await request('/sessions/export', payload('POST', { ids }));
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mini-harness-sessions.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function deleteSelected() {
    if (!confirm('Permanently delete ' + selection.size + ' selected conversations and their descendants?')) return;
    const result = await data<{ deleted: string[] }>('/sessions/delete', payload('POST', { ids: [...selection] }));
    if (result.deleted.includes(options.active())) options.clearConversation();
    selection.clear();
    toggleSelection(false);
    await sync();
  }

  let renaming: string;
  function renameSession(item: Conversation) {
    renaming = item.id; element<'input'>('sessionTitle').value = item.title; element('renameStatus').textContent = '';
    element<'dialog'>('renamePanel').showModal(); element<'input'>('sessionTitle').select();
  }
  element('renameClose').onclick = () => element<'dialog'>('renamePanel').close();
  element<'form'>('renameForm').onsubmit = async (event) => {
    event.preventDefault();
    try { await data('/sessions/' + renaming, payload('PATCH', { title: value('sessionTitle') })); await sync(); element<'dialog'>('renamePanel').close(); }
    catch (error) { element('renameStatus').textContent = error.message; }
  };
  async function deleteSession(item: Conversation) {
    if (!confirm('Permanently delete "' + item.title + '" and all child conversations?')) return;
    try {
      const result = await data<{ deleted: string[] }>('/sessions/delete', payload('POST', { ids: [item.id] }));
      if (result.deleted.includes(options.active())) options.clearConversation();
      await sync();
    } catch (error) { options.report(error); }
  }
  let sessions: Conversation[] = [];
  const { renderSessions, selection, expanded, toggleSelection } = createSessionList(
    () => ({ sessions, active: options.active() }), options.activate, renameSession, deleteSession
  );
  async function sync() {
    const next = await data<Conversation[]>('/sessions');
    if (JSON.stringify(next) === JSON.stringify(sessions)) return;
    update(next);
    const active = options.active();
    if (active) element('conversationTitle').textContent = sessions.find((item) => item.id === active)?.title ?? 'Conversation';
  }
  function update(next: Conversation[]) {
    sessions = next;
    for (const id of selection) if (!sessions.some((item) => item.id === id)) selection.delete(id);
    renderSessions();
  }
  element('exportSessions').onclick = () => void exportSessions([...selection]).catch(options.report);
  element('deleteSessions').onclick = () => void deleteSelected().catch(options.report);
  const refresh = setInterval(() => { if (!document.hidden) void sync().catch(() => {}); }, 1500);
  api.onDispose(() => clearInterval(refresh));
  return {
    render: renderSessions, sync, update, export: exportSessions,
    add(item: Conversation) { sessions.unshift(item); },
    title(id: string) { return sessions.find((item) => item.id === id)?.title; },
    reveal(id: string | null) {
      for (let parent = id; parent && !expanded.has(parent); parent = sessions.find((entry) => entry.id === parent)?.parentId) expanded.add(parent);
    }
  };
}
