import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import type {} from '@mini-harness/workspaces/browser/api';
import type { WorkspaceRecord } from '@mini-harness/workspaces/record';
import { button, field, confirmAction } from '@mini-harness/ui-primitives/primitives';
import { payload } from '@mini-harness/ui-runtime/http';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import { fileLabel, icon } from '@mini-harness/ui-primitives/icons';

const setup = (ctx: Context) => {
  const signal = ctx.fiber.signal;
  const { miniSelection: select, miniSessions: sessions, miniWorkspaces: workspaces, miniTabs: tabs } = ctx;
  const picker = workspacePicker(ctx, sessions.get);
  const badges = (['workspace.header', 'workspace.welcome'] as const).map((slot) => {
    const node = document.createElement('div');
    node.className = 'workspace-button';
    const label = document.createElement('small');
    node.append(icon('folder'), label);
    ctx.effect(() => ctx.miniSlots.register(slot, node));
    return { node, label };
  });
  ctx.provide('miniWorkspace', picker);
  const update = () => {
    const selected = workspaces.get().find(({ id }) => id === select.selectedWorkspace);
    for (const { node, label } of badges) {
      label.textContent = selected?.path ?? '';
      node.title = selected?.path ?? '';
      node.hidden = !selected;
    }
    tabs.selectScope(select.scope() || undefined);
    tabs.prune(new Set(sessions.get().map(({ id }) => id)), new Set(workspaces.get().map(({ id }) => id)));
  };
  select.subscribe(update, signal);
  sessions.subscribe(update, signal);
  update();
};

declare module 'mini-harness/cordis' {
  interface Context { miniWorkspace: ReturnType<typeof workspacePicker> }
}

interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
}

function workspacePicker(ctx: Context, sessions: () => { workspaceId: string }[]) {
  const signal = ctx.fiber.signal;
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
  const { node: picker, dispose: disposePicker } = ctx.miniDialogs.create('Add workspace', form);
  ctx.effect(() => disposePicker);
  let selected: (record: WorkspaceRecord) => void;
  let browsing: AbortController;
  picker.addEventListener('close', () => browsing?.abort());

  async function browse(target: string) {
    browsing?.abort();
    const controller = browsing = new AbortController();
    status.textContent = '';
    list.setAttribute('aria-busy', 'true');
    try {
      const result = await browserRequest<DirectoryListing>(ctx, '/workspaces/directories?path=' + encodeURIComponent(target), { signal: controller.signal });
      if (controller.signal.aborted) return;
      path.value = result.path;
      up.disabled = !result.parent;
      up.onclick = () => { if (result.parent) void browse(result.parent); };
      list.replaceChildren(...result.directories.map((entry) => {
        const row = button('', 'quiet');
        row.classList.add('file-entry');
        fileLabel(row, entry.name, 'folder');
        row.onclick = () => void browse(entry.path);
        return row;
      }));
      if (!result.directories.length) list.textContent = 'No subdirectories';
    } catch (error) { if (!controller.signal.aborted) status.textContent = (error instanceof Error ? error.message : String(error)); }
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
      const record = await browserRequest<WorkspaceRecord>(ctx, '/workspaces', payload('POST', { path: path.value.trim() }));
      picker.close();
      selected(record);
    } catch (error) { status.textContent = (error instanceof Error ? error.message : String(error)); }
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
  const { node: editor, dispose: disposeEditor } = ctx.miniDialogs.create('Rename workspace', editForm);
  ctx.effect(() => disposeEditor);
  editor.classList.add('workspace-rename-dialog');
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
      await browserRequest(ctx, workspaceRoute(editing.id), payload('PATCH', { name: name.value.trim() }));
      editor.close();
    } catch (error) { editStatus.textContent = (error instanceof Error ? error.message : String(error)); }
    finally { rename.disabled = false; }
  };

  return {
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
      const count = sessions().filter((session) => session.workspaceId === record.id).length;
      if (!await confirmAction('Permanently delete workspace "' + record.name + '" and its ' + count +
        ' conversation' + (count === 1 ? '' : 's') + ' (including subagents)? Workspace files will be kept.',
        { title: 'Delete workspace', signal })) return;
      await browserRequest(ctx, workspaceRoute(record.id), { method: 'DELETE' });
    }
  };
}

export default { inject: ['miniSelection','miniSessions','miniWorkspaces','miniTabs','miniDialogs','miniSlots'], provide: ['miniWorkspace'], apply: setup };
