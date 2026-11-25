import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { Context } from 'mini-harness/cordis';
import type { ModelCatalog } from '@mini-harness/models/catalog';
import type { WorkspaceRecord } from '@mini-harness/workspaces/record';
import type { Conversation } from '@mini-harness/conversation/view';
import type { ProfileConfiguration } from '@mini-harness/plugin-api/configuration';
import type { PluginMetadata } from '../shared/metadata.ts';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import { payload } from '@mini-harness/ui-runtime/http';
import { icon } from '@mini-harness/ui-primitives/icons';
import {
  button,
  field,
  fromMarkup,
  saveToggle,
  toggle,
  required,
} from '@mini-harness/ui-primitives/primitives';
import { readPluginValues, schemaFields } from './fields.ts';

const setup = async (ctx: Context) => {
  const signal = ctx.fiber.signal;
  const {
    miniSettingsData: settings,
    miniPages: pages,
    miniSwitch: syncPlugins,
    miniBrowserFailures: browserFailures,
    miniModels: models,
  } = ctx;
  const plugins = new RemoteStore(() => browserRequest<PluginMetadata[]>(ctx, '/plugins'));
  await plugins.refresh();
  ctx.effect(() => ctx.miniProjections.register('plugins', plugins));
  const refresh = async () => {
    await Promise.all([plugins.refresh(), settings.refresh()]);
    const failures = await syncPlugins();
    if (failures.size) throw new Error('Browser plugins failed: ' + [...failures.keys()].join(', '));
  };
  const catalog = pluginCatalog(
    ctx,
    () => ({
      plugins: plugins.get().map((plugin) => {
        const error = browserFailures.get(plugin.id);
        return error ? { ...plugin, state: 'failed' as const, error } : plugin;
      }),
      settings: settings.get(),
    }),
    refresh,
    pages,
    () => models.get(),
    ctx.miniSettingsRegistry,
  );
  plugins.subscribe(catalog.refresh, signal);
  settings.subscribe(catalog.refresh, signal);
  browserFailures.subscribe(catalog.refresh, signal);
};

function pluginCatalog(
  ctx: Context,
  snapshot: () => { plugins: PluginMetadata[]; settings: ProfileConfiguration },
  refresh: () => Promise<void>,
  pages: { open(id?: string): void; register(id: string, node: HTMLElement): () => void },
  modelCatalog: () => ModelCatalog,
  registry: Context['miniSettingsRegistry'],
) {
  const entry = fromMarkup<HTMLButtonElement>(
    '<button type="button" class="nav-action" aria-label="Browse plugins" aria-controls="pluginCatalog"><span class="nav-label">Plugins</span></button>',
  );
  entry.prepend(icon('plugin'));
  const page =
    fromMarkup(`<section id="pluginCatalog" class="catalog-page" tabindex="-1" aria-label="Plugin catalog">
    <header class="catalog-header">
      <div class="catalog-heading"><h1>Plugins</h1><p class="hint">Enable and configure Profile plugins.</p></div>
    </header>
    <p class="hint catalog-status" role="status"></p>
    <div class="catalog-content"></div>
  </section>`);
  const header = required(page.querySelector('header'));
  const content = required(page.querySelector('.catalog-content'));
  const status = required(page.querySelector<HTMLElement>('.catalog-status'));
  entry.dataset.pageLink = 'plugins';
  ctx.effect(() => ctx.miniSlots.register('sidebar.actions', entry, -10));
  ctx.effect(() => pages.register('plugins', page));

  let detailLifetime: AbortController | undefined;
  ctx.effect(() => () => detailLifetime?.abort());
  let busy = false;
  let savingSwitch = false;
  async function mutate(operation: () => Promise<unknown>, failed: (error: Error) => void) {
    if (busy) return false;
    busy = true;
    try {
      await operation();
      try {
        await refresh();
      } catch (error) {
        failed(new Error('Saved on the server. ' + (error instanceof Error ? error.message : String(error))));
      }
      return true;
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));
      return false;
    } finally {
      busy = false;
    }
  }

  function detail(plugin: PluginMetadata) {
    status.textContent = '';
    header.hidden = true;
    detailLifetime?.abort();
    detailLifetime = new AbortController();
    const section = fromMarkup(`<section class="catalog-detail settings-scroll">
      <header class="catalog-detail-header"><div class="plugin-symbol"></div><h1></h1><p class="hint"></p></header>
    </section>`);
    const back = button('All plugins', 'quiet');
    back.classList.add('catalog-back');
    back.prepend(icon('chevron'));
    back.onclick = () => {
      render();
      rowButton(plugin.id)?.focus();
    };
    section.prepend(back);
    required(section.querySelector('.plugin-symbol')).append(icon(plugin.icon ?? 'plugin'));
    required(section.querySelector('h1')).textContent = plugin.title;
    required(section.querySelector('p')).textContent = plugin.description;
    const schema = plugin.configSchema;
    const diagnostics = document.createElement('p');
    diagnostics.className = 'hint';
    diagnostics.textContent = plugin.error ?? '';
    section.append(diagnostics);
    const form = fromMarkup<HTMLFormElement>(
      '<form><div class="detail-fields"></div><p class="hint" role="status"></p></form>',
    );
    const save = button('Save configuration', 'primary');
    save.type = 'submit';
    form.append(save);
    const fields = required(form.querySelector<HTMLElement>('.detail-fields'));
    const outcome = required(form.querySelector<HTMLElement>('[role="status"]'));
    const scopePicker = document.createElement('select');
    const scopedControls = document.createElement('div');
    const enabled = toggle('Enabled in this scope', false);
    const configFields = document.createElement('div');
    fields.append(scopedControls, configFields);
    const locationsByKey = new Map<string, ScopeKey>();
    const currentKey = () => locationsByKey.get(scopePicker.value);
    const currentScope = () => {
      const key = currentKey();
      return (key && snapshot().settings.scopes[key]) || undefined;
    };
    const values = () => ({
      ...snapshot().settings.entries[plugin.id]?.config,
      ...currentScope()?.entries?.[plugin.id]?.config,
    });
    function renderFields() {
      configFields.replaceChildren();
      const key = currentKey();
      const instance = snapshot()
        .plugins.find(({ id }) => id === plugin.id)
        ?.instances?.find(({ scope }) => scope === (key ?? 'application'));
      diagnostics.textContent =
        instance?.error ?? (instance?.state === 'inactive' ? 'Waiting for this scope to activate.' : '');
      enabled.checked = key
        ? currentScope()?.entries?.[plugin.id]?.disabled === false
        : snapshot().settings.entries[plugin.id]?.disabled === false;
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
    scopedControls.className = 'plugin-fields';
    scopedControls.append(field('Scope', scopePicker), field('Enabled in this scope', enabled));
    scopePicker.add(new Option('Application', 'application'));
    const instances = plugin.instances ?? [];
    for (const { scope } of instances) {
      if (scope === 'application') continue;
      locationsByKey.set(scope, scope);
      scopePicker.add(new Option(scope, scope));
    }
    const selected =
      instances.find(({ state }) => state === 'failed')?.scope ??
      instances.find(({ state }) => state === 'ready' || state === 'inactive')?.scope ??
      'application';
    scopePicker.value = selected;
    scopePicker.onchange = renderFields;
    renderFields();
    void Promise.all([
      browserRequest<WorkspaceRecord[]>(ctx, '/workspaces'),
      browserRequest<Conversation[]>(ctx, '/sessions'),
    ])
      .then(([workspaces, sessions]) => {
        const add = (key: ScopeKey, label: string) => {
          locationsByKey.set(key, key);
          const existing = [...scopePicker.options].find((option) => option.value === key);
          if (existing) existing.textContent = label;
          else scopePicker.add(new Option(label, key));
        };
        for (const { id, name } of workspaces) add(`workspace:${id}`, 'Workspace: ' + name);
        for (const { id, title } of sessions) add(`session:${id}`, 'Conversation: ' + title);
      })
      .catch((error: Error) => {
        outcome.textContent = error.message;
      });
    form.onsubmit = async (event) => {
      event.preventDefault();
      save.disabled = true;
      outcome.textContent = '';
      try {
        const key = currentKey();
        const previous = key
          ? currentScope()?.entries?.[plugin.id]?.config
          : snapshot().settings.entries[plugin.id]?.config;
        const config = schema
          ? readPluginValues({ [plugin.id]: previous ?? {} }, configFields)[plugin.id]
          : previous;
        let patch: Partial<ProfileConfiguration> = {
          entries: { [plugin.id]: { disabled: !enabled.checked, config } },
        };
        if (key) {
          const current = currentScope() ?? {};
          patch = {
            scopes: {
              ...snapshot().settings.scopes,
              [key]: {
                ...current,
                entries: {
                  ...current.entries,
                  [plugin.id]: { ...current.entries?.[plugin.id], disabled: !enabled.checked, config },
                },
              },
            },
          };
        }
        const saved = await mutate(
          () => browserRequest(ctx, '/settings', payload('PATCH', patch)),
          (error) => {
            outcome.textContent = error.message;
          },
        );
        if (saved && !outcome.textContent) {
          const latest = snapshot().plugins.find(({ id }) => id === plugin.id);
          const state = key ? latest?.instances?.find(({ scope }) => scope === key) : latest;
          diagnostics.textContent = state?.error ?? '';
          outcome.textContent =
            state?.error && (state.state === 'failed' || state.state === 'partial')
              ? 'Configuration saved. Plugin failed to start: ' + state.error
              : state?.state === 'inactive'
                ? 'Configuration saved. Waiting for this scope to activate.'
                : 'Saved.';
        }
      } catch (error) {
        outcome.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        save.disabled = false;
      }
    };
    section.append(form);
    registry.mountPlugin(plugin.id, section, detailLifetime.signal);
    content.replaceChildren(section);
    back.focus();
  }

  const rowButton = (id: string) =>
    content.querySelector<HTMLButtonElement>('[data-plugin-row="' + id + '"]');

  function render() {
    const focused = document.activeElement as HTMLElement;
    const focusId = focused?.dataset.pluginRow ?? focused?.dataset.pluginToggle;
    const isToggle = focused?.dataset.pluginToggle !== undefined;
    detailLifetime?.abort();
    detailLifetime = undefined;
    header.hidden = false;
    const { settings, plugins } = snapshot();
    const groups = [
      { title: 'Built-in capabilities', plugins: plugins.filter((plugin) => !plugin.trustedCode) },
      { title: 'Local plugins', plugins: plugins.filter((plugin) => plugin.trustedCode) },
    ];
    content.replaceChildren(
      ...groups.map((group) => {
        const list = fromMarkup('<section class="catalog-group"><h2></h2></section>');
        required(list.querySelector('h2')).textContent = group.title;
        if (!group.plugins.length)
          list.append(fromMarkup('<p class="hint">No external plugins available.</p>'));
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
          const state = {
            ready: 'Ready',
            failed: 'Failed',
            partial: 'Partially ready',
            inactive: 'Inactive',
            disabled: 'Disabled',
          }[plugin.state ?? 'disabled'];
          required(row.querySelector('small')).textContent =
            state + ' · ' + (plugin.error ?? plugin.description);
          const controls = required(row.querySelector('.catalog-controls'));
          const checked = settings.entries[plugin.id]?.disabled === false;
          const control = toggle(plugin.title, checked);
          control.dataset.pluginToggle = plugin.id;
          saveToggle(control, async (next) => {
            if (busy) return false;
            savingSwitch = true;
            status.textContent = '';
            const peers = [...content.querySelectorAll<HTMLInputElement>('input.toggle')].filter(
              (toggle) => toggle !== control && !toggle.disabled,
            );
            for (const peer of peers) peer.disabled = true;
            try {
              const saved = await mutate(
                () =>
                  browserRequest(
                    ctx,
                    '/settings',
                    payload('PATCH', { entries: { [plugin.id]: { disabled: !next } } }),
                  ),
                (error) => {
                  status.textContent = error.message;
                },
              );
              if (saved) {
                const state = snapshot().plugins.find(({ id }) => id === plugin.id);
                if (next && state?.error && !status.textContent)
                  status.textContent = 'Configuration saved. Plugin failed to start: ' + state.error;
                if (!detailLifetime) render();
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
      }),
    );
    if (focusId) {
      const next = isToggle
        ? content.querySelector<HTMLElement>('[data-plugin-toggle="' + focusId + '"]')
        : rowButton(focusId);
      next?.focus();
    }
  }
  function open() {
    status.textContent = '';
    render();
    pages.open('plugins');
  }
  entry.onclick = open;
  return {
    open,
    refresh: () => {
      if (!detailLifetime && !savingSwitch) render();
    },
  };
}

export default {
  inject: [
    'miniProjections',
    'miniSettingsData',
    'miniSettingsRegistry',
    'miniPages',
    'miniSwitch',
    'miniBrowserFailures',
    'miniModels',
    'miniSlots',
  ],
  provide: [],
  apply: setup,
};
