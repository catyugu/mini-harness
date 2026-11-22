import type { Conversation } from '../src/registry.js';
import { scopedElements } from './api.js';
import { icon } from './icons.js';
export function createSessionList(root: HTMLElement, state: () => { sessions: Conversation[]; active?: string }, activate: (id: string) => void, rename: (item: Conversation) => void, remove: (item: Conversation) => void) {
const { element, value } = scopedElements(root);
let selecting = false, searchQuery = '';
let visibleSessions: Conversation[] = [];
const selection = new Set<string>(), expanded = new Set<string>();
function renderSessions() {
  const { sessions, active } = state();
  const included = new Set<string>();
  for (const item of sessions) if (item.title.toLowerCase().includes(searchQuery)) {
    included.add(item.id);
    for (let parent = item.parentId; parent; parent = sessions.find((s) => s.id === parent)?.parentId) included.add(parent);
  }
  visibleSessions = searchQuery ? sessions.filter((s) => included.has(s.id)) : sessions;
  const roots = new Map<string | null, Conversation[]>();
  for (const item of visibleSessions) {
    if (!roots.has(item.parentId)) roots.set(item.parentId, []);
    roots.get(item.parentId).push(item);
  }

  function branch(parent: string | null) {
    const list = document.createElement('ul');
    for (const item of roots.get(parent) ?? []) {
      const entry = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'session-row' + (item.id === active ? ' active' : '');
      if (roots.has(item.id)) {
        const toggle = document.createElement('button');
        const open = expanded.has(item.id);
        toggle.type = 'button';
        toggle.className = 'tree-button';
        toggle.append(icon('chevron')); 
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', (open ? 'Collapse ' : 'Expand ') + item.title);
        toggle.onclick = () => {
          if (open) expanded.delete(item.id);
          else expanded.add(item.id);
          renderSessions();
          element('tree-' + item.id)?.focus();
        };
        toggle.id = 'tree-' + item.id;
        row.append(toggle);
      }
      if (selecting) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'select-' + item.id;
        checkbox.checked = selection.has(item.id);
        checkbox.setAttribute('aria-label', 'Select ' + item.title);
        checkbox.onchange = () => {
          if (checkbox.checked) selection.add(item.id);
          else selection.delete(item.id);
          updateSelection();
        };
        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = item.title;
        row.append(checkbox, label);
      } else {
        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'session-name';
        title.textContent = item.title;
        title.title = item.title;
        if (item.id === active) title.setAttribute('aria-current', 'page');
        title.onclick = () => activate(item.id);
        row.append(title);
        const actions = document.createElement('div'); actions.className = 'session-actions';
        for (const [name, image, action] of [
          ['Rename', 'edit', () => rename(item)],
          ['Delete', 'trash', () => remove(item)]
        ] as const) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button';
          button.setAttribute('aria-label', name + ' ' + item.title); button.title = name; button.append(icon(image)); button.onclick = action; actions.append(button);
        }
        row.append(actions);
      }
      entry.append(row);
      if (item.run && item.run.state !== 'completed') {
        const state = document.createElement('span');
        state.className = 'run-state';
        state.dataset.state = item.run.state;
        state.textContent = item.run.state;
        state.title = item.run.error ?? item.run.state;
        row.append(state);
      }
      if ((expanded.has(item.id) || searchQuery) && roots.has(item.id)) entry.append(branch(item.id));
      list.append(entry);
    }
    return list;
  }
  element('sessions').replaceChildren(branch(null));
  updateSelection();
}

function updateSelection() {
  element('selectMode').setAttribute('aria-pressed', String(selecting));
  element('bulkActions').hidden = !selecting;
  element('selectedCount').textContent = selection.size + ' selected';
  element<'button'>('exportSessions').disabled = !selection.size;
  element<'button'>('deleteSessions').disabled = !selection.size;
}

function toggleSelection(value: boolean) { selecting = value; selection.clear(); renderSessions(); }
element('selectMode').onclick = () => toggleSelection(!selecting);
element('cancelSelection').onclick = () => toggleSelection(false);
element('selectAll').onclick = () => { for (const item of visibleSessions) selection.add(item.id); renderSessions(); };
element<'input'>('sessionSearch').oninput = () => { searchQuery = value('sessionSearch').toLowerCase(); renderSessions(); };
return { renderSessions, selection, expanded, toggleSelection };
}
