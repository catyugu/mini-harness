import type { FrontendApi } from './extensions.js';
import { element, payload } from './api.js';
export function pluginInstaller(api: FrontendApi, refresh: () => Promise<void>) {
  const section = document.createElement('section'), title = document.createElement('h3'), hint = document.createElement('p');
  title.textContent = 'Install local plugin'; hint.className = 'hint';
  hint.textContent = 'Choose plugin.js with optional plugin.json and web.js. Plugins run trusted local code with your permissions. New installs stay disabled until you enable them.';
  const label = document.createElement('label'); label.textContent = 'Plugin ID';
  const id = document.createElement('input'); id.placeholder = 'my-plugin'; id.setAttribute('aria-label', 'Install plugin ID'); label.append(id);
  const files = document.createElement('input'); files.type = 'file'; files.multiple = true; files.accept = '.js,.json'; files.setAttribute('aria-label', 'Plugin bundle files');
  const button = document.createElement('button'); button.type = 'button'; button.className = 'small-button'; button.textContent = 'Install trusted plugin';
  const status = document.createElement('p'); status.className = 'hint'; status.setAttribute('role', 'status');
  button.onclick = async () => {
    button.disabled = true;
    try {
      const bundle = await Promise.all([...files.files].map(async (file) => ({ name: file.name, content: await file.text() })));
      await api.request('/plugins/install', payload('POST', { id: id.value.trim(), files: bundle }));
      await refresh(); status.textContent = 'Installed. Enable the plugin in settings to load it.'; files.value = ''; id.value = '';
    } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
  };
  section.append(title, hint, label, files, button, status); element('installPluginSettings').append(section);
  return () => section.remove();
}
