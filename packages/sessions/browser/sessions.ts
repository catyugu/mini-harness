import type { Conversation } from '@mini-harness/contracts/conversation';
import { sessionHierarchy } from './navigation-tree.js';
import { button, iconButton } from '@mini-harness/ui-primitives/primitives';

export function sessionTree(sessions: Conversation[], options: {
  active?: string; expanded: Set<string>; selection: Set<string>; selecting: boolean;
  query: string; matches?: ReadonlySet<string>; render(): void; selectionChanged(): void;
  activate(id: string): void; rename(item: Conversation): void; remove(item: Conversation): void;
}) {
  const { active, expanded, selection, selecting, query } = options;
  const { children, visible } = sessionHierarchy(sessions, query, options.matches);

  function branch(parent: string | null) {
    const list = document.createElement('ul');
    list.className = 'session-branch';
    for (const item of children.get(parent) ?? []) {
      const entry = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'session-row' + (item.id === active ? ' active' : '');
      const open = expanded.has(item.id) || Boolean(query);
      if (children.has(item.id)) {
        const toggle = iconButton((open ? 'Collapse ' : 'Expand ') + item.title, 'chevron', 'tree-button');
        toggle.id = 'tree-' + item.id;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.onclick = () => {
          if (open) expanded.delete(item.id);
          else expanded.add(item.id);
          options.render();
        };
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
          options.selectionChanged();
        };
        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = item.title;
        row.append(checkbox, label);
      } else {
        const title = button(item.title, 'quiet');
        title.id = 'session-' + item.id;
        title.classList.add('session-name');
        title.title = item.title;
        if (item.id === active) title.setAttribute('aria-current', 'page');
        title.onclick = () => options.activate(item.id);
        row.append(title);
        const actions = document.createElement('div');
        actions.className = 'session-actions';
        for (const [name, image, action] of [
          ['Rename', 'edit', () => options.rename(item)],
          ['Delete', 'trash', () => options.remove(item)]
        ] as const) {
          const control = iconButton(name + ' ' + item.title, image);
          control.id = name.toLowerCase() + '-' + item.id;
          control.onclick = action;
          actions.append(control);
        }
        row.append(actions);
      }
      const status = item.waitingApproval ? 'approval' : item.run?.state;
      if (status === 'approval' || status === 'running' || status === 'queued') {
        const marker = document.createElement('span');
        marker.className = 'run-state';
        marker.dataset.state = status;
        marker.textContent = item.waitingApproval ? 'Approval' : status;
        marker.title = item.waitingApproval ? 'Waiting for approval' : item.run.error ?? status;
        row.append(marker);
      }
      entry.append(row);
      if (open && children.has(item.id)) entry.append(branch(item.id));
      list.append(entry);
    }
    return list;
  }
  return { list: branch(null), visible };
}
