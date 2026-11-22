import { element, data, payload } from './api.js';
import { fileLabel } from './files.js';
export function workspacePicker() {
  const dialog = element<'dialog'>('workspacePanel'), status = element('workspaceStatus');
  element('workspaceOpen').onclick = async () => {
    try {
      const result = await data<{ current: string; paths: string[] }>('/workspaces');
      element<'input'>('workspacePath').value = result.current; status.textContent = '';
      element('workspaceList').replaceChildren(...result.paths.map((path) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'file-entry'; fileLabel(button, path, 'folder'); button.title = path;
        button.onclick = () => { element<'input'>('workspacePath').value = path; }; return button;
      }));
      dialog.showModal();
    } catch (error) { status.textContent = error.message; dialog.showModal(); }
  };
  element('workspaceClose').onclick = () => dialog.close();
  element<'form'>('workspaceForm').onsubmit = async (event) => {
    event.preventDefault(); const button = element<'button'>('switchWorkspace'); button.disabled = true;
    try { await data('/workspaces', payload('POST', { path: element<'input'>('workspacePath').value.trim() })); location.reload(); }
    catch (error) { status.textContent = error.message; button.disabled = false; }
  };
}
