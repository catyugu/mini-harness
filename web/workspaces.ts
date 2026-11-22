import type { WorkspaceRecord } from '../src/workspace-catalog.js';
import type { BrowserPlugin, FrontendApi } from './extensions.js';
import { button, dialog, field } from './primitives.js';
import { payload, workspaceRoute } from './api.js';
import { fileLabel, icon } from './icons.js';

export const workspacePlugin: BrowserPlugin = {
  id: 'core:workspace', inject: ['miniState'],
  setup(ctx, api) {
    const { miniState: state } = ctx;
    ctx.provide('miniWorkspace', workspacePicker(api, () => state.get().workspaces));
  }
};

declare module 'cordis' {
  interface Context { miniWorkspace: ReturnType<typeof workspacePicker> }
}

interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
}

function workspacePicker(api: FrontendApi, records: () => WorkspaceRecord[]) {
  const form = document.createElement('form');
  form.className = 'workspace-form';
  const path = document.createElement('input');
  path.required = true;
  const go = button('Browse');
  const up = button('Up', 'quiet');
  const list = document.createElement('div');
  list.className = 'directory-list';
  list.setAttribute('aria-label', 'Subdirectories');
  const status = document.createElement('p');
  status.className = 'form-error';
  status.setAttribute('role', 'status');
  const register = button('Add workspace', 'primary');
  register.type = 'submit';
  const browseActions = document.createElement('div');
  browseActions.className = 'ui-actions';
  browseActions.append(up, go);
  form.append(field('Absolute directory path', path), browseActions, list, status, register);
  const picker = dialog('Add workspace', form);
  api.mount('dialogs', picker);
  let selected: (record: WorkspaceRecord) => void;
  let browsing: AbortController;
  picker.addEventListener('close', () => browsing?.abort());

  async function browse(target: string) {
    browsing?.abort();
    const controller = browsing = new AbortController();
    status.textContent = '';
    list.setAttribute('aria-busy', 'true');
    try {
      const result = await api.request<DirectoryListing>('/workspaces/directories?path=' + encodeURIComponent(target), { signal: controller.signal });
      if (controller.signal.aborted) return;
      path.value = result.path;
      up.disabled = !result.parent;
      up.onclick = () => void browse(result.parent);
      list.replaceChildren(...result.directories.map((entry) => {
        const row = button('', 'quiet');
        row.classList.add('file-entry');
        fileLabel(row, entry.name, 'folder');
        row.onclick = () => void browse(entry.path);
        return row;
      }));
      if (!result.directories.length) list.textContent = 'No subdirectories';
    } catch (error) { if (!controller.signal.aborted) status.textContent = error.message; }
    finally { if (browsing === controller) list.removeAttribute('aria-busy'); }
  }

  path.addEventListener('input', () => {
    browsing?.abort();
    list.replaceChildren();
    up.disabled = true;
  });
  go.onclick = () => void browse(path.value);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (register.disabled) return;
    register.disabled = true;
    try {
      const record = await api.request<WorkspaceRecord>('/workspaces', payload('POST', { path: path.value.trim() }));
      picker.close();
      selected(record);
    } catch (error) { status.textContent = error.message; }
    finally { register.disabled = false; }
  };

  const editForm = document.createElement('form');
  editForm.className = 'workspace-form';
  const name = document.createElement('input');
  name.required = true;
  name.maxLength = 140;
  const location = document.createElement('p');
  location.className = 'workspace-location hint';
  const editStatus = document.createElement('p');
  editStatus.className = 'form-error';
  editStatus.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'ui-actions';
  const rename = button('Save name', 'primary');
  rename.type = 'submit';
  const earlier = button('Move up');
  const later = button('Move down');
  const relocate = button('Change directory');
  relocate.onclick = () => {
    const path = prompt('New absolute workspace directory', editing.path);
    if (path && path !== editing.path) void change(() => api.request(workspaceRoute(editing.id), payload('PATCH', { path })));
  };
  const remove = button('Remove workspace', 'danger');
  actions.append(earlier, later, relocate, remove, rename);
  editForm.append(location, field('Workspace name', name), actions, editStatus);
  const editor = dialog('Manage workspace', editForm);
  api.mount('dialogs', editor);
  let editing: WorkspaceRecord;

  async function change(operation: () => Promise<unknown>) {
    if (rename.disabled) return;
    for (const action of actions.querySelectorAll('button')) action.disabled = true;
    try { await operation(); editor.close(); }
    catch (error) { editStatus.textContent = error.message; }
    finally { for (const action of actions.querySelectorAll('button')) action.disabled = false; }
  }
  function move(offset: number) {
    const ids = records().map(({ id }) => id);
    const index = ids.indexOf(editing.id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void change(() => api.request('/workspaces', payload('PUT', { ids })));
  }
  earlier.onclick = () => move(-1);
  later.onclick = () => move(1);
  remove.onclick = () => {
    if (confirm('Remove “' + editing.name + '” from the workspace list? All its conversations and child conversations will be permanently deleted. Project files on disk are kept.'))
      void change(() => api.request(workspaceRoute(editing.id), payload('DELETE', { deleteSessions: true })));
  };
  editForm.onsubmit = (event) => {
    event.preventDefault();
    void change(() => api.request(workspaceRoute(editing.id), payload('PATCH', { name: name.value })));
  };

  const current = document.createElement('div');
  current.className = 'workspace-button';
  current.append(icon('folder'));
  const currentLabel = document.createElement('small');
  currentLabel.id = 'workspaceLabel';
  current.append(currentLabel);
  return {
    current,
    label(record?: WorkspaceRecord) {
      currentLabel.textContent = record?.path ?? '';
      current.title = record?.path ?? '';
      current.hidden = !record;
    },
    open(record: WorkspaceRecord | undefined, onAdd: typeof selected) {
      selected = onAdd;
      path.value = record?.path ?? '';
      list.replaceChildren();
      picker.showModal();
      void browse(path.value);
    },
    manage(record: WorkspaceRecord) {
      editing = record;
      name.value = record.name;
      location.textContent = record.path;
      editStatus.textContent = '';
      const items = records();
      const index = items.findIndex(({ id }) => id === record.id);
      earlier.disabled = index <= 0;
      later.disabled = index >= items.length - 1;
      editor.showModal();
      name.select();
    }
  };
}
