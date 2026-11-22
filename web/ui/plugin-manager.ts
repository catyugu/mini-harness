import type { SettingsPatch } from '../../src/config.js';
import type { PluginMetadata } from '../../src/kernel/plugin-api.js';
import type { BrowserPlugin, FrontendApi } from '../kernel/extensions.js';
import type { Bootstrap } from '../types.js';
import { payload } from '../api.js';
import { icon } from './components/icons.js';
import { button, dialog, field, fromMarkup, iconButton, saveToggle, toggle } from './components/primitives.js';
import { readPluginValues, schemaFields } from './settings-fields.js';

export const catalogPlugin: BrowserPlugin = {
  id: 'core:plugins', inject: ['miniState', 'miniShell', 'miniSwitch'],
  setup(ctx, api) {
    const { miniState: state, miniShell: shell, miniSwitch: syncPlugins } = ctx;
    const refresh = async () => {
      await state.refresh();
      const failures = await syncPlugins(state.get());
      if (failures.size) throw new Error('Browser plugins failed: ' + [...failures.keys()].join(', '));
    };
    const catalog = pluginCatalog(api, state.get, refresh, shell.showPage);
    state.on('bootstrap', catalog.refresh, api.signal);
  }
};

const bundleNames = ['plugin.js', 'plugin.json', 'web.js'];

function installer(api: FrontendApi, installed: () => Promise<void>) {
  const form = fromMarkup<HTMLFormElement>(`<form class="install-plugin">
    <input class="bundle-input" type="file" multiple accept=".js,.json" aria-label="Plugin bundle files" tabindex="-1">
    <div class="bundle-drop">
      <span>Drop plugin files here or</span>
      <ul class="bundle-files" aria-label="Selected files"></ul>
    </div>
    <p class="bundle-trust">Local plugins run with your user permissions. Install code you trust.</p>
    <p class="hint form-error" role="alert"></p>
    <div class="ui-actions"></div>
  </form>`);
  const modal = dialog('Install plugin', form);
  const id = fromMarkup<HTMLInputElement>('<input pattern="[a-z](?:[a-z0-9]|-){0,63}" placeholder="my-plugin" required>');
  form.prepend(field('Plugin ID', id));
  const input = form.querySelector<HTMLInputElement>('.bundle-input');
  const drop = form.querySelector<HTMLElement>('.bundle-drop');
  const list = form.querySelector('.bundle-files');
  const outcome = form.querySelector<HTMLElement>('[role="alert"]');
  const choose = button('Choose files');
  choose.onclick = () => input.click();
  drop.insertBefore(choose, list);
  const cancel = button('Cancel', 'quiet');
  cancel.onclick = () => modal.close();
  const submit = button('Install plugin', 'primary');
  submit.type = 'submit';
  form.querySelector('.ui-actions').append(cancel, submit);
  let files: File[] = [];
  let installing = false;

  function setFiles(selection: File[]) {
    files = selection;
    const names = selection.map((file) => file.name);
    let error = '';
    if (names.some((name) => !bundleNames.includes(name)) || new Set(names).size !== names.length)
      error = 'Choose one copy each of plugin.js, plugin.json and web.js.';
    else if (!names.includes('plugin.js') && !names.includes('web.js')) error = 'Include plugin.js or web.js (or both).';
    else if (selection.reduce((total, file) => total + file.size, 0) > 1024 * 1024) error = 'Plugin bundle exceeds 1 MiB.';
    outcome.textContent = error;
    submit.disabled = installing || Boolean(error);
    list.replaceChildren(...selection.map((file) => {
      const item = document.createElement('li');
      item.textContent = file.name;
      return item;
    }));
  }

  input.onchange = () => setFiles([...input.files]);
  drop.ondragover = (event) => { event.preventDefault(); if (!installing) drop.dataset.dragging = 'true'; };
  drop.ondragleave = (event) => { if (!drop.contains(event.relatedTarget as Node)) delete drop.dataset.dragging; };
  drop.ondrop = (event) => {
    event.preventDefault();
    delete drop.dataset.dragging;
    if (!installing) setFiles([...event.dataTransfer.files]);
  };
  modal.addEventListener('close', () => {
    form.reset();
    setFiles([]);
    outcome.textContent = '';
  });
  modal.addEventListener('cancel', (event) => { if (installing) event.preventDefault(); });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    installing = submit.disabled = choose.disabled = cancel.disabled = true;
    try {
      const bundle = await Promise.all(files.map(async (file) => ({ name: file.name, content: await file.text() })));
      await api.request('/plugins/install', payload('POST', { id: id.value.trim(), files: bundle }));
      await installed();
      modal.close();
    } catch (error) { outcome.textContent = error.message; }
    finally { installing = submit.disabled = choose.disabled = cancel.disabled = false; }
  };
  submit.disabled = true;
  api.mount('dialogs', modal);
  return modal;
}

function pluginCatalog(api: FrontendApi, snapshot: () => Bootstrap, refresh: () => Promise<void>, showPage: (page?: HTMLElement) => void) {
  const entry = fromMarkup<HTMLButtonElement>('<button type="button" class="nav-action" aria-label="Browse plugins" aria-controls="pluginCatalog"><span class="nav-label">Plugins</span></button>');
  entry.prepend(icon('plugin'));
  const page = fromMarkup(`<section id="pluginCatalog" class="catalog-page" tabindex="-1" aria-label="Plugin catalog">
    <header class="catalog-header">
      <div class="catalog-heading"><h1>Plugins</h1><p class="hint">Install, enable, and configure plugins.</p></div>
    </header>
    <p class="hint catalog-status" role="status"></p>
    <div class="catalog-content"></div>
  </section>`);
  const openInstall = button('Install plugin', 'primary');
  openInstall.prepend(icon('plus'));
  const header = page.querySelector('header');
  const content = page.querySelector('.catalog-content');
  const status = page.querySelector<HTMLElement>('.catalog-status');
  header.append(openInstall);
  const modal = installer(api, async () => {
    await refresh();
    status.textContent = 'Plugin installed. Enable it to load it.';
  });
  openInstall.onclick = () => modal.showModal();
  api.mount('sidebar', entry, -10);
  api.mount('main', page);

  let editing: string | undefined;
  let busy = false;
  let savingSwitch = false;
  async function mutate(operation: () => Promise<unknown>, failed: (error: Error) => void) {
    if (busy) return false;
    busy = true;
    try {
      await operation();
      try { await refresh(); }
      catch (error) { failed(new Error('Saved on the server. ' + error.message)); }
      return true;
    } catch (error) { failed(error); return false; }
    finally { busy = false; }
  }

  function detail(plugin: PluginMetadata) {
    status.textContent = '';
    header.hidden = true;
    editing = plugin.id;
    const section = fromMarkup(`<section class="catalog-detail settings-scroll">
      <header class="catalog-detail-header"><div class="plugin-symbol"></div><h1></h1><p class="hint"></p></header>
    </section>`);
    const back = button('All plugins', 'quiet');
    back.classList.add('catalog-back');
    back.prepend(icon('chevron'));
    back.onclick = () => { render(); rowButton(plugin.id)?.focus(); };
    section.prepend(back);
    section.querySelector('.plugin-symbol').append(icon(plugin.icon ?? 'plugin'));
    section.querySelector('h1').textContent = plugin.title;
    section.querySelector('p').textContent = plugin.description;
    const schema = plugin.preferences?.schema ?? plugin.configSchema;
    if (schema) {
      const form = fromMarkup<HTMLFormElement>('<form><div class="detail-fields"></div><p class="hint" role="status"></p></form>');
      const save = button('Save configuration', 'primary');
      save.type = 'submit';
      form.append(save);
      const fields = form.querySelector<HTMLElement>('.detail-fields');
      const outcome = form.querySelector<HTMLElement>('[role="status"]');
      const key = plugin.preferences?.key;
      const values = () => key ? snapshot().settings[key] : snapshot().settings.pluginConfig[plugin.id] ?? {};
      if (key === 'sandbox') {
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = snapshot().isolation ? 'Linux shell isolation is available. Trusted host mode uses your user permissions.'
          : 'Shell isolation is unavailable on this host. Trusted host mode uses your user permissions.';
        fields.append(note);
      }
      if (plugin.preferences?.groups) {
        for (const group of plugin.preferences.groups) {
          const block = fromMarkup('<section class="ui-section"><h3></h3></section>');
          block.querySelector('h3').textContent = group.title;
          const properties = Object.fromEntries(group.fields.map((id) => [id, schema.properties[id]]));
          block.append(schemaFields(plugin.id, { ...schema, properties }, values()));
          fields.append(block);
        }
      } else fields.append(schemaFields(plugin.id, schema, values()));
      form.onsubmit = async (event) => {
        event.preventDefault();
        save.disabled = true;
        outcome.textContent = '';
        try {
          const current = values();
          const config = readPluginValues({ [plugin.id]: current }, fields)[plugin.id];
          if (key) for (const [name, value] of Object.entries(current)) {
            if (typeof value === 'string' && !Object.hasOwn(config, name)) config[name] = '';
          }
          const patch: SettingsPatch = key ? { [key]: config } : { pluginConfig: { [plugin.id]: config } };
          const saved = await mutate(() => api.request('/settings', payload('PATCH', patch)),
            (error) => { outcome.textContent = error.message; });
          if (saved && !outcome.textContent) outcome.textContent = 'Saved.';
        } catch (error) { outcome.textContent = error.message; }
        finally { save.disabled = false; }
      };
      section.append(form);
    }
    content.replaceChildren(section);
    back.focus();
  }

  const rowButton = (id: string) => content.querySelector<HTMLButtonElement>('[data-plugin-row="' + id + '"]');

  function render() {
    const focused = document.activeElement as HTMLElement;
    const focusId = focused?.dataset.pluginRow ?? focused?.dataset.pluginToggle;
    const isToggle = focused?.dataset.pluginToggle !== undefined;
    editing = undefined;
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
          <button class="catalog-description ui-list-item" type="button">
            <span class="plugin-symbol"></span><span><strong></strong><small></small></span>
          </button>
          <div class="catalog-controls"></div>
        </article>`);
        const open = row.querySelector('button');
        open.dataset.pluginRow = plugin.id;
        open.setAttribute('aria-label', plugin.title + ' settings');
        open.onclick = () => detail(plugin);
        row.querySelector('.plugin-symbol').append(icon(plugin.icon ?? 'plugin'));
        row.querySelector('strong').textContent = plugin.title;
        row.querySelector('small').textContent = plugin.description;
        const controls = row.querySelector('.catalog-controls');
        const checked = Boolean(settings.plugins[plugin.id]);
        const control = toggle(plugin.title, checked);
        control.dataset.pluginToggle = plugin.id;
        const remove = plugin.trustedCode ? iconButton('Uninstall ' + plugin.title, 'trash', 'icon-button danger') : undefined;
        if (remove) {
          remove.hidden = checked;
          remove.onclick = async () => {
            if (!confirm('Permanently uninstall ' + plugin.title + '?')) return;
            remove.disabled = true;
            status.textContent = '';
            const deleted = await mutate(() => api.request('/plugins/' + plugin.id, { method: 'DELETE' }),
              (error) => { status.textContent = error.message; });
            if (deleted) { status.textContent ||= 'Plugin uninstalled.'; openInstall.focus(); }
            remove.disabled = false;
          };
          controls.append(remove);
        }
        saveToggle(control, async (next) => {
          if (busy) return false;
          savingSwitch = true;
          status.textContent = '';
          const peers = [...content.querySelectorAll<HTMLInputElement>('input.toggle')].filter((toggle) => toggle !== control && !toggle.disabled);
          for (const peer of peers) peer.disabled = true;
          try {
            const saved = await mutate(() => api.request('/settings', payload('PATCH', { plugins: { [plugin.id]: next } })),
              (error) => { status.textContent = error.message; });
            if (saved && remove) remove.hidden = next;
            return saved;
          } finally {
            savingSwitch = false;
            for (const peer of peers) peer.disabled = false;
          }
        });
        controls.append(control);
        list.append(row);
      }
      return list;
    }));
    if (focusId) {
      const next = isToggle ? content.querySelector<HTMLElement>('[data-plugin-toggle="' + focusId + '"]') : rowButton(focusId);
      next?.focus();
    }
  }
  function open() { status.textContent = ''; render(); showPage(page); }
  entry.onclick = open;
  return { open, refresh: () => { if (!editing && !savingSwitch) render(); } };
}
