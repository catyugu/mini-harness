import type { ModelCatalog } from '@mini-harness/web/types';
import type { WorkspaceRecord } from '@mini-harness/contracts/workspace';
import type { Conversation } from '@mini-harness/contracts/conversation';
import type { Settings, SettingsPatch } from '@mini-harness/contracts/config';
import type { PluginMetadata } from '@mini-harness/contracts/plugins';
import { RemoteStore } from '@mini-harness/web/models/remote-store';
import type { FrontendSetup, FrontendApi } from '@mini-harness/ui-runtime/frontend';
import { payload } from '@mini-harness/web/api';
import { icon } from '@mini-harness/ui-primitives/icons';
import { button, field, fromMarkup, iconButton, saveToggle, toggle, confirmAction, required } from '@mini-harness/ui-primitives/primitives';
import { readPluginValues, schemaFields } from './browser/fields.js';

const setup: FrontendSetup = async (ctx, api) => {
  const { miniSettingsData: settings, miniPages: pages, miniSwitch: syncPlugins, miniBrowserFailures: browserFailures, miniModels: models } = ctx;
  const plugins = new RemoteStore(() => api.request<PluginMetadata[]>('/plugins'));
  await plugins.refresh();
  api.onDispose(ctx.miniProjections.register('plugins', plugins));
  ctx.provide('miniPluginData', plugins);
  const refresh = async () => {
    await Promise.all([plugins.refresh(), settings.refresh()]);
    const failures = await syncPlugins();
    if (failures.size) throw new Error('Browser plugins failed: ' + [...failures.keys()].join(', '));
  };
  const catalog = pluginCatalog(api, () => ({ plugins: plugins.get().map((plugin) => browserFailures.has(plugin.id)
    ? { ...plugin, state: 'failed' as const, error: 'Browser setup or resource loading failed.' } : plugin), settings: settings.get() }), refresh, pages, () => models.get());
  plugins.subscribe(catalog.refresh, api.signal);
  settings.subscribe(catalog.refresh, api.signal);
  browserFailures.subscribe(catalog.refresh, api.signal);
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
  const modal = api.dialog('Install plugin', form);
  const id = fromMarkup<HTMLInputElement>('<input pattern="[a-z](?:[a-z0-9]|-){0,63}" placeholder="my-plugin" required>');
  form.prepend(field('Plugin ID', id));
  const input = required(form.querySelector<HTMLInputElement>('.bundle-input'));
  const drop = required(form.querySelector<HTMLElement>('.bundle-drop'));
  const list = required(form.querySelector('.bundle-files'));
  const outcome = required(form.querySelector<HTMLElement>('[role="alert"]'));
  const choose = button('Choose files');
  choose.onclick = () => input.click();
  drop.insertBefore(choose, list);
  const cancel = button('Cancel', 'quiet');
  cancel.onclick = () => modal.close();
  const submit = button('Install plugin', 'primary');
  submit.type = 'submit';
  required(form.querySelector('.ui-actions')).append(cancel, submit);
  let files: File[] = [];
  let installing = false;

  function setFiles(selection: File[]) {
    files = selection;
    const names = selection.map((file) => file.name);
    let error = '';
    if (names.some((name) => !bundleNames.includes(name)) || new Set(names).size !== names.length)
      error = 'Choose one copy each of plugin.js, plugin.json and web.js.';
    else if (!names.includes('plugin.json')) error = 'Include plugin.json.';
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

  input.onchange = () => setFiles([...(input.files ?? [])]);
  drop.ondragover = (event) => { event.preventDefault(); if (!installing) drop.dataset.dragging = 'true'; };
  drop.ondragleave = (event) => { if (!drop.contains(event.relatedTarget as Node)) delete drop.dataset.dragging; };
  drop.ondrop = (event) => {
    event.preventDefault();
    delete drop.dataset.dragging;
    if (!installing) setFiles([...(event.dataTransfer?.files ?? [])]);
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
    } catch (error) { outcome.textContent = (error instanceof Error ? error.message : String(error)); }
    finally { installing = submit.disabled = choose.disabled = cancel.disabled = false; }
  };
  submit.disabled = true;
  return modal;
}

function pluginCatalog(api: FrontendApi, snapshot: () => { plugins: PluginMetadata[]; settings: Settings }, refresh: () => Promise<void>, pages: { open(id?: string): void; register(id: string, node: HTMLElement): () => void }, modelCatalog: () => ModelCatalog) {
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
  const header = required(page.querySelector('header'));
  const content = required(page.querySelector('.catalog-content'));
  const status = required(page.querySelector<HTMLElement>('.catalog-status'));
  header.append(openInstall);
  const modal = installer(api, async () => {
    await refresh();
    status.textContent = 'Plugin installed. Enable it to load it.';
  });
  openInstall.onclick = () => modal.showModal();
  entry.dataset.pageLink = 'plugins';
  api.slots.register('sidebar.actions', entry, -10);
  api.onDispose(pages.register('plugins', page));

  let editing: string | undefined;
  let busy = false;
  let savingSwitch = false;
  async function mutate(operation: () => Promise<unknown>, failed: (error: Error) => void) {
    if (busy) return false;
    busy = true;
    try {
      await operation();
      try { await refresh(); }
      catch (error) { failed(new Error('Saved on the server. ' + (error instanceof Error ? error.message : String(error)))); }
      return true;
    } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); return false; }
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
    required(section.querySelector('.plugin-symbol')).append(icon(plugin.icon ?? 'plugin'));
    required(section.querySelector('h1')).textContent = plugin.title;
    required(section.querySelector('p')).textContent = plugin.description;
    const schema = plugin.configSchema;
    const scoped = plugin.scope === 'workspace' || plugin.scope === 'session';
    const diagnostics = document.createElement('p');
    diagnostics.className = 'hint';
    diagnostics.textContent = plugin.error ?? '';
    section.append(diagnostics);
    const form = fromMarkup<HTMLFormElement>('<form><div class="detail-fields"></div><p class="hint" role="status"></p></form>');
    const save = button('Save configuration', 'primary');
    save.type = 'submit';
    form.append(save);
    const fields = required(form.querySelector<HTMLElement>('.detail-fields'));
    const outcome = required(form.querySelector<HTMLElement>('[role="status"]'));
    const scopePicker = document.createElement('select');
    const scopedControls = document.createElement('div');
    const enabled = toggle('Enabled in this scope', false);
    const provision = document.createElement('fieldset');
    const services = new Map<string, HTMLInputElement>();
    const configFields = document.createElement('div');
    fields.append(scopedControls, configFields);
    const currentScope = () => snapshot().settings.scopes[scopePicker.value];
    const values = () => ({ ...snapshot().settings.pluginConfig[plugin.id], ...currentScope()?.pluginConfig?.[plugin.id] });
    function renderFields() {
      configFields.replaceChildren();
      if (scoped) {
        const instance = snapshot().plugins.find(({ id }) => id === plugin.id)?.instances?.find(({ scope }) => scope === scopePicker.value);
        diagnostics.textContent = instance?.error ?? (instance?.state === 'inactive' ? 'Waiting for this scope to activate.' : '');
        enabled.checked = currentScope()?.plugins?.[plugin.id] === true;
        services.clear();
        provision.replaceChildren();
        const legend = document.createElement('legend');
        legend.textContent = 'Services provided in this scope';
        provision.append(legend);
        const providers = currentScope()?.providers ?? {};
        const supplied = Object.keys(providers).filter((key) => providers[key] === plugin.id);
        for (const service of new Set([...(plugin.provides ?? []), ...supplied])) {
          const box = toggle('Use ' + plugin.title + ' for ' + service, providers[service] === plugin.id);
          services.set(service, box);
          provision.append(field(service, box));
        }
        provision.hidden = !services.size;
      }
      if (!schema) return;
      if (plugin.configHint) {
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = plugin.configHint;
        configFields.append(note);
      }
      if (plugin.configGroups) {
        for (const group of plugin.configGroups) {
          const block = fromMarkup('<section class="ui-section"><h3></h3></section>');
          required(block.querySelector('h3')).textContent = group.title;
          const properties = Object.fromEntries(group.fields.map((id) => [id, schema.properties[id]]));
          block.append(schemaFields(plugin.id, { ...schema, properties }, values(), modelCatalog()));
          configFields.append(block);
        }
      } else configFields.append(schemaFields(plugin.id, schema, values(), modelCatalog()));
    }
    if (scoped) {
      scopedControls.className = 'plugin-fields';
      scopedControls.append(field(plugin.scope === 'workspace' ? 'Workspace' : 'Conversation', scopePicker),
        field('Enabled in this scope', enabled), provision);
      save.disabled = true;
      scopePicker.add(new Option('Choose a scope', ''));
      scopedControls.querySelectorAll('input').forEach((control) => { control.disabled = true; });
      const locations = plugin.scope === 'workspace'
        ? api.request<WorkspaceRecord[]>('/workspaces').then((items) => items.map(({ id, name }) => ({ key: 'workspace:' + id, name })))
        : api.request<Conversation[]>('/sessions').then((items) => items.map(({ id, title }) => ({ key: 'session:' + id, name: title })));
      void locations.then((items) => {
        for (const { key, name } of items) scopePicker.add(new Option(name, key));
        for (const { scope } of plugin.instances ?? [])
          if (!items.some(({ key }) => key === scope)) scopePicker.add(new Option(scope, scope));
        scopePicker.value = plugin.instances?.find(({ error }) => error)?.scope ?? items[0]?.key ?? plugin.instances?.[0]?.scope ?? '';
        const sync = () => {
          save.disabled = !scopePicker.value;
          enabled.disabled = !scopePicker.value;
          renderFields();
        };
        scopePicker.onchange = sync;
        sync();
      }).catch((error: Error) => { outcome.textContent = error.message; });
    } else renderFields();
    form.onsubmit = async (event) => {
      event.preventDefault();
      save.disabled = true;
      outcome.textContent = '';
      try {
        const config = readPluginValues({ [plugin.id]: {} }, configFields)[plugin.id];
        let patch: SettingsPatch = { pluginConfig: { [plugin.id]: config } };
        const key = scopePicker.value;
        if (scoped) {
          const current = currentScope() ?? {};
          const providers = { ...current.providers };
          for (const [service, box] of services) {
            if (box.checked && enabled.checked) providers[service] = plugin.id;
            else if (providers[service] === plugin.id) delete providers[service];
          }
          patch = { scopes: { ...snapshot().settings.scopes, [key]: { ...current, providers,
            plugins: { ...current.plugins, [plugin.id]: enabled.checked },
            pluginConfig: { ...current.pluginConfig, [plugin.id]: config } } } };
        }
        const saved = await mutate(() => api.request('/settings', payload('PATCH', patch)),
          (error) => { outcome.textContent = error.message; });
        if (saved && !outcome.textContent) {
          const latest = snapshot().plugins.find(({ id }) => id === plugin.id);
          const state = scoped ? latest?.instances?.find(({ scope }) => scope === key) : latest;
          diagnostics.textContent = state?.error ?? '';
          outcome.textContent = state?.error && (state.state === 'failed' || state.state === 'partial')
            ? 'Configuration saved. Plugin failed to start: ' + state.error
            : state?.state === 'inactive' ? 'Configuration saved. Waiting for this scope to activate.' : 'Saved.';
        }
      } catch (error) { outcome.textContent = (error instanceof Error ? error.message : String(error)); }
      finally { save.disabled = false; }
    };
    if (schema || scoped) section.append(form);
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
      required(list.querySelector('h2')).textContent = group.title;
      if (!group.plugins.length) list.append(fromMarkup('<p class="hint">No local plugins installed.</p>'));
      for (const plugin of group.plugins) {
        const row = fromMarkup(`<article class="catalog-row">
          <button class="catalog-description ui-list-item" type="button">
            <span class="plugin-symbol"></span><span><strong></strong><small></small></span>
          </button>
          <div class="catalog-controls"></div>
        </article>`);
        const open = required(row.querySelector('button'));
        open.dataset.pluginRow = plugin.id;
        open.setAttribute('aria-label', plugin.title + ' settings');
        open.onclick = () => detail(plugin);
        required(row.querySelector('.plugin-symbol')).append(icon(plugin.icon ?? 'plugin'));
        required(row.querySelector('strong')).textContent = plugin.title;
        const state = { ready: 'Ready', failed: 'Failed', partial: 'Partially ready', inactive: 'Inactive', disabled: 'Disabled' }[plugin.state ?? 'disabled'];
        required(row.querySelector('small')).textContent = state + ' · ' + (plugin.error ?? plugin.description);
        const controls = required(row.querySelector('.catalog-controls'));
        const scoped = plugin.scope && plugin.scope !== 'application';
        const checked = scoped ? Object.values(settings.scopes).some((scope) => scope.plugins?.[plugin.id]) :
          Boolean(settings.plugins[plugin.id]);
        const control = toggle(plugin.title, checked);
        control.dataset.pluginToggle = plugin.id;
        if (scoped) {
          control.disabled = true;
          control.title = 'Open plugin settings to select a scope';
        }
        const remove = plugin.trustedCode ? iconButton('Uninstall ' + plugin.title, 'trash', 'icon-button danger') : undefined;
        if (remove) {
          remove.hidden = checked;
          remove.onclick = async () => {
            if (!await confirmAction('Permanently uninstall ' + plugin.title + '?',
              { title: 'Uninstall plugin', confirmLabel: 'Uninstall', signal: api.signal })) return;
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
            if (saved) {
              if (remove) remove.hidden = next;
              const state = snapshot().plugins.find(({ id }) => id === plugin.id);
              if (next && state?.error && !status.textContent)
                status.textContent = 'Configuration saved. Plugin failed to start: ' + state.error;
            }
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
  function open() { status.textContent = ''; render(); pages.open('plugins'); }
  entry.onclick = open;
  return { open, refresh: () => { if (!editing && !savingSwitch) render(); } };
}

declare module 'cordis' {
  interface Context { miniPluginData: RemoteStore<PluginMetadata[]> }
}

export default setup;
