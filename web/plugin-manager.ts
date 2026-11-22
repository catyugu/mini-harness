import type { Settings } from '../src/config.js';
import type { PluginMetadata } from '../src/plugins.js';
import type { FrontendApi } from './extensions.js';
import type { Bootstrap } from './types.js';
import { payload } from './api.js';
import { icon } from './icons.js';
import { closeOnBackdrop, fromMarkup } from './primitives.js';
import { readPluginValues, schemaFields } from './settings-fields.js';

export function installForm(api: FrontendApi, refresh: () => Promise<void>) {
  const section = fromMarkup(`<section class="install-plugin">
    <p class="hint">Choose plugin.js and optional plugin.json or web.js. Local plugins run with your user permissions.</p>
    <label>Plugin ID<input aria-label="Install plugin ID" placeholder="my-plugin"></label>
    <input type="file" multiple accept=".js,.json" aria-label="Plugin bundle files">
    <button type="button" class="small-button">Install trusted plugin</button>
    <p class="hint" role="status"></p>
  </section>`);
  const [id, files] = section.querySelectorAll('input');
  const button = section.querySelector('button'), status = section.querySelector<HTMLElement>('[role="status"]');
  button.onclick = async () => {
    button.disabled = true;
    try {
      const bundle = await Promise.all([...files.files].map(async (file) => ({ name: file.name, content: await file.text() })));
      await api.request('/plugins/install', payload('POST', { id: id.value.trim(), files: bundle }));
      await refresh();
      status.textContent = 'Installed. Enable the plugin to load it.';
      files.value = id.value = '';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };
  return section;
}

export function pluginCatalog(api: FrontendApi, snapshot: () => Bootstrap, refresh: () => Promise<void>, showPage: (page?: HTMLElement) => void) {
  const entry = fromMarkup<HTMLButtonElement>('<button type="button" class="nav-action"> <span class="nav-label">Plugins</span></button>');
  entry.prepend(icon('plugin'));
  entry.setAttribute('aria-label', 'Browse plugins');
  entry.setAttribute('aria-controls', 'pluginCatalog');
  const page = fromMarkup(`<section id="pluginCatalog" class="catalog-page" tabindex="-1" aria-label="Plugin catalog">
    <header class="catalog-header">
      <h1>Plugins</h1>
      <button type="button" class="primary">Install plugin</button>
    </header>
    <p class="hint catalog-status" role="status"></p>
    <div class="catalog-content"></div>
  </section>`);
  const dialog = fromMarkup<HTMLDialogElement>(`<dialog class="workspace-panel" aria-label="Install plugin">
    <header class="settings-header"><h2>Install plugin</h2><button type="button" class="icon-button" aria-label="Close installation"></button></header>
    <div class="settings-scroll"></div>
  </dialog>`);
  dialog.querySelector('button').append(icon('close'));
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.querySelector('.settings-scroll').append(installForm(api, refresh));
  closeOnBackdrop(dialog);
  const header = page.querySelector('header'), content = page.querySelector('.catalog-content');
  const status = page.querySelector<HTMLElement>('.catalog-status');
  header.querySelector('button').onclick = () => dialog.showModal();
  entry.onclick = () => { render(); showPage(page); };
  api.mount('sidebar', entry, -10);
  api.mount('main', page);
  api.mount('dialogs', dialog);

  let mutating = false;
  async function update(patch: Partial<Settings>, onError: (error: Error) => void) {
    if (mutating) return false;
    mutating = true;
    try {
      await api.request('/settings', payload('PATCH', patch));
      await refresh();
      return true;
    } catch (error) { onError(error); return false; }
    finally { mutating = false; }
  }

  function detail(plugin: PluginMetadata) {
    status.textContent = '';
    header.hidden = true;
    const section = fromMarkup(`<section class="catalog-detail settings-scroll">
      <button type="button" class="link-button">← All plugins</button>
      <h1></h1><p class="hint"></p>
      <form><div class="detail-fields"></div><p class="hint" role="status"></p><button class="primary">Save configuration</button></form>
    </section>`);
    section.querySelector('h1').textContent = plugin.title;
    section.querySelector('p').textContent = plugin.description;
    section.querySelector('button').onclick = () => render();
    const form = section.querySelector('form'), fields = section.querySelector<HTMLElement>('.detail-fields');
    const outcome = form.querySelector<HTMLElement>('[role="status"]');
    const key = plugin.preferences?.key;
    const settings = snapshot().settings;
    const values = key ? settings[key] : settings.pluginConfig[plugin.id] ?? {};
    fields.append(schemaFields(plugin.id, plugin.preferences?.schema ?? plugin.configSchema, values));
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      try {
        button.disabled = true;
        const config = readPluginValues({ [plugin.id]: values }, fields)[plugin.id];
        if (key) for (const [field, value] of Object.entries(values)) {
          if (typeof value === 'string' && !Object.hasOwn(config, field)) config[field] = '';
        }
        const saved = await update(key ? { [key]: config } : { pluginConfig: { [plugin.id]: config } },
          (error) => { outcome.textContent = error.message; });
        if (saved) outcome.textContent = 'Saved.';
      } catch (error) { outcome.textContent = error.message; }
      finally { button.disabled = false; }
    };
    content.replaceChildren(section);
    section.querySelector('button').focus();
  }

  function render() {
    header.hidden = false;
    const { settings, plugins } = snapshot();
    const groups = [
      { title: 'Built-in capabilities', plugins: plugins.filter((plugin) => !plugin.trustedCode) },
      { title: 'Local plugins', plugins: plugins.filter((plugin) => plugin.trustedCode) }
    ];
    content.replaceChildren(...groups.map((group) => {
      const list = fromMarkup('<section class="catalog-group"><h2></h2></section>');
      list.querySelector('h2').textContent = group.title;
      if (!group.plugins.length) list.append(fromMarkup('<p class="hint">No local plugins installed.</p>'));
      for (const plugin of group.plugins) {
        const row = fromMarkup(`<article class="catalog-row">
          <div class="plugin-symbol"></div><div class="catalog-description"><h3></h3><p></p></div>
          <div class="catalog-controls"></div>
        </article>`);
        row.querySelector('.plugin-symbol').append(icon(plugin.icon ?? 'plugin'));
        row.querySelector('h3').textContent = plugin.title;
        row.querySelector('p').textContent = plugin.description;
        const controls = row.querySelector('.catalog-controls');
        if (plugin.preferences || plugin.configSchema) {
          const configure = fromMarkup<HTMLButtonElement>('<button type="button" class="link-button">Configure</button>');
          configure.setAttribute('aria-label', 'Configure ' + plugin.title);
          configure.onclick = () => detail(plugin);
          controls.append(configure);
        }
        const toggle = fromMarkup<HTMLInputElement>('<input class="toggle" type="checkbox" role="switch">');
        toggle.setAttribute('aria-label', plugin.title);
        toggle.checked = Boolean(settings.plugins[plugin.id]);
        toggle.onchange = async () => {
          if (mutating) { toggle.checked = !toggle.checked; return; }
          const enabled = toggle.checked;
          toggle.disabled = true;
          const saved = await update({ plugins: { [plugin.id]: enabled } }, (error) => { status.textContent = error.message; });
          toggle.checked = saved ? enabled : !enabled;
          toggle.disabled = false;
          if (saved) status.textContent = '';
        };
        if (plugin.trustedCode && !toggle.checked) {
          const remove = fromMarkup<HTMLButtonElement>('<button type="button" class="icon-button danger" title="Uninstall"></button>');
          remove.append(icon('trash'));
          remove.setAttribute('aria-label', 'Uninstall ' + plugin.title);
          remove.onclick = async () => {
            if (!confirm('Permanently uninstall ' + plugin.title + '?')) return;
            try { await api.request('/plugins/' + plugin.id, { method: 'DELETE' }); await refresh(); render(); }
            catch (error) { status.textContent = error.message; }
          };
          controls.append(remove);
        }
        controls.append(toggle);
        list.append(row);
      }
      return list;
    }));
  }
  return { refresh: () => { if (!header.hidden) render(); } };
}
