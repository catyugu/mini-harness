import type { Conversation, SessionSearchResult } from '@mini-harness/contracts/conversation';
import { sessionHierarchy } from './navigation-tree.js';
import { button, iconButton } from '@mini-harness/ui-primitives/primitives';

function highlight(node: HTMLElement, text: string, start: number, end: number) {
  const mark = document.createElement('mark');
  mark.textContent = text.slice(start, end);
  node.replaceChildren(text.slice(0, start), mark, text.slice(end));
}

export function sessionTree(sessions: Conversation[], options: {
  active?: string; expanded: Set<string>; selection: Set<string>; selecting: boolean;
  query: string; highlight: string; matches: ReadonlyMap<string, SessionSearchResult>; render(): void; selectionChanged(): void;
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
      const hit = options.matches.get(item.id);
      const titleMatch = (node: HTMLElement) => {
        if (hit?.field === 'title' && hit.snippet === item.title) highlight(node, item.title, ...hit.match);
        else if (options.highlight) {
          const start = item.title.toLowerCase().indexOf(options.highlight);
          if (start >= 0) highlight(node, item.title, start, start + options.highlight.length);
        }
      };
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
        titleMatch(label);
        row.append(checkbox, label);
      } else {
        const title = button(item.title, 'quiet');
        title.id = 'session-' + item.id;
        title.classList.add('session-name');
        title.title = item.title;
        titleMatch(title);
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
        marker.title = item.waitingApproval ? 'Waiting for approval' : item.run?.error ?? status;
        row.append(marker);
      }
      entry.append(row);
      if (hit?.field === 'message') {
        const snippet = document.createElement('div');
        snippet.className = 'session-match';
        highlight(snippet, hit.snippet, ...hit.match);
        entry.append(snippet);
      }
      if (open && children.has(item.id)) entry.append(branch(item.id));
      list.append(entry);
    }
    return list;
  }
  return { list: branch(null), visible };
}
