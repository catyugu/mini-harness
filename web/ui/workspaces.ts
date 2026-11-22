import type { WorkspaceRecord } from '../../src/workspace-catalog.js';
import type { BrowserPlugin, FrontendApi } from '../kernel/extensions.js';
import { button, dialog, field } from './primitives.js';
import { payload, workspaceRoute } from '../api.js';
import { fileLabel, icon } from './icons.js';

export const workspacePlugin: BrowserPlugin = {
  id: 'core:workspace', inject: ['miniState'],
  setup(ctx, api) {
    const { miniState: state } = ctx;
    const picker = workspacePicker(api);
    ctx.provide('miniWorkspace', picker);
    state.on('navigation', () => picker.label(state.workspace()), api.signal);
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

function workspacePicker(api: FrontendApi) {
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
  editForm.className = 'workspace-rename-form';
  const name = document.createElement('input');
  name.required = true;
  name.maxLength = 140;
  name.autocomplete = 'off';
  name.setAttribute('aria-label', 'Workspace name');
  const editStatus = document.createElement('p');
  editStatus.className = 'form-error';
  editStatus.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'ui-actions';
  const cancel = button('Cancel', 'quiet');
  const rename = button('Rename', 'primary');
  rename.type = 'submit';
  actions.append(cancel, rename);
  editForm.append(name, editStatus, actions);
  const editor = dialog('Rename workspace', editForm);
  editor.classList.add('workspace-rename-dialog');
  api.mount('dialogs', editor);
  let editing: WorkspaceRecord;
  cancel.onclick = () => editor.close();
  name.oninput = () => {
    editStatus.textContent = '';
    rename.disabled = !name.value.trim() || name.value.trim() === editing?.name;
  };
  editForm.onsubmit = async (event) => {
    event.preventDefault();
    if (rename.disabled) return;
    rename.disabled = true;
    try {
      await api.request(workspaceRoute(editing.id), payload('PATCH', { name: name.value.trim() }));
      editor.close();
    } catch (error) { editStatus.textContent = error.message; }
    finally { rename.disabled = false; }
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
    rename(record: WorkspaceRecord) {
      editing = record;
      name.value = record.name;
      editStatus.textContent = '';
      rename.disabled = true;
      editor.showModal();
      name.select();
    },
    async remove(record: WorkspaceRecord) {
      if (!confirm('Remove workspace "' + record.name + '" from the list? Its directory and conversations will be kept.')) return;
      await api.request(workspaceRoute(record.id), { method: 'DELETE' });
    }
  };
}
