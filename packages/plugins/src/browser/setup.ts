import { browserRequest, payload } from '@mini-harness/ui-runtime/http';
import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import type { Context } from 'mini-harness/cordis';
import type { ProfileConfiguration } from '@mini-harness/plugin-api/configuration';
import type { PluginMetadata } from '../shared/metadata.ts';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import { icon } from '@mini-harness/ui-primitives/icons';
import { button, fromMarkup, saveToggle, toggle, required } from '@mini-harness/ui-primitives/primitives';
import { schemaForm } from './fields.ts';

type CatalogPlugin = Omit<PluginMetadata, 'instances'>;
const optional = (plugin: CatalogPlugin) => !plugin.id.startsWith('core:');

const setup = async (ctx: Context) => {
  const signal = ctx.fiber.signal;
  const { miniSettingsData: settings, miniSwitch: syncPlugins, miniBrowserFailures: browserFailures } = ctx;
  const plugins = new RemoteStore(() => browserRequest<CatalogPlugin[]>(ctx, '/plugins'));
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
  );
  plugins.subscribe(catalog.refresh, signal);
  settings.subscribe(catalog.refresh, signal);
  browserFailures.subscribe(catalog.refresh, signal);
};

function pluginCatalog(
  ctx: Context,
  snapshot: () => { plugins: CatalogPlugin[]; settings: ProfileConfiguration },
  refresh: () => Promise<void>,
) {
  const { miniPages: pages, miniSettingsRegistry: registry } = ctx;
  const entry = fromMarkup<HTMLButtonElement>(
    '<button type="button" class="ui-button ui-nav-action" data-variant="quiet" aria-label="Browse plugins" aria-controls="pluginCatalog"><span class="ui-nav-label ui-truncate">Plugins</span></button>',
  );
  entry.prepend(icon('plugin'));
  const page =
    fromMarkup(`<section id="pluginCatalog" class="catalog-page" tabindex="-1" aria-label="Plugin catalog">
    <header class="catalog-header">
      <div class="catalog-heading"><h1>Plugins</h1><p class="hint">Configure built-in capabilities and manage local plugins.</p></div>
    </header>
    <p class="hint catalog-status" role="status"></p>
    <div class="catalog-content"></div>
  </section>`);
  const header = required(page.querySelector('header'));
  const content = required(page.querySelector('.catalog-content'));
  const status = required(page.querySelector<HTMLElement>('.catalog-status'));
  const builtins = fromMarkup(`<div class="builtin-plugins">
    <p class="hint catalog-status" role="status"></p>
    <div class="builtin-list"></div>
  </div>`);
  const builtinStatus = required(builtins.querySelector<HTMLElement>('.catalog-status'));
  const builtinList = required(builtins.querySelector('.builtin-list'));
  ctx.effect(() => ctx.miniSlots.register('sidebar.actions', entry, { order: -10 }));
  ctx.effect(() => pages.register('plugins', page, entry));
  registry.registerSection(
    { id: 'built-in-plugins', title: 'Built-in plugins', icon: 'plugin', order: 30 },
    ctx.fiber.signal,
  );
  ctx.effect(() =>
    registry.register(
      browserPluginId(ctx),
      {
        id: 'built-in-plugins',
        sectionId: 'built-in-plugins',
        render: () => builtins,
      },
      browserPluginSettings(ctx),
    ),
  );

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

  function detail(plugin: CatalogPlugin) {
    status.textContent = '';
    header.hidden = true;
    detailLifetime?.abort();
    detailLifetime = new AbortController();
    const { signal } = detailLifetime;
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
    const diagnostics = document.createElement('p');
    diagnostics.className = 'hint';
    diagnostics.textContent = plugin.error ?? '';
    section.append(diagnostics);
    if (plugin.configForm && plugin.configSchema) {
      const values = snapshot().settings.entries[plugin.id]?.config ?? {};
      section.append(
        schemaForm(plugin.id, plugin.configSchema, values, plugin.configForm.description, async (config) => {
          let failure = '';
          const saved = await mutate(
            () =>
              browserRequest(ctx, '/settings', payload('PATCH', { entries: { [plugin.id]: { config } } })),
            (error) => {
              failure = error.message;
            },
          );
          if (!saved || failure) return failure;
          const latest = snapshot().plugins.find(({ id }) => id === plugin.id);
          diagnostics.textContent = latest?.error ?? '';
          return latest?.error ? 'Configuration saved. Plugin failed to start: ' + latest.error : 'Saved.';
        }),
      );
    } else {
      const configuration = document.createElement('div');
      section.append(configuration);
      registry.mountPlugin(plugin.id, configuration, signal);
    }
    content.replaceChildren(section);
    back.focus();
  }

  const rowButton = (id: string) =>
    content.querySelector<HTMLButtonElement>('[data-plugin-row="' + id + '"]');

  function switchFor(plugin: CatalogPlugin, outcome: HTMLElement) {
    const control = toggle(plugin.title, snapshot().settings.entries[plugin.id]?.disabled !== true);
    control.dataset.pluginToggle = plugin.id;
    saveToggle(control, async (next) => {
      if (busy) return false;
      savingSwitch = true;
      outcome.textContent = '';
      const peers = [content, builtinList]
        .flatMap((root) => [
          ...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input.toggle, [data-plugin-row]'),
        ])
        .filter((peer) => peer !== control && !peer.disabled);
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
            outcome.textContent = error.message;
          },
        );
        if (saved) {
          const state = snapshot().plugins.find(({ id }) => id === plugin.id);
          if (next && state?.error && !outcome.textContent)
            outcome.textContent = 'Configuration saved. Plugin failed to start: ' + state.error;
          if (!detailLifetime) render();
          renderBuiltins();
        }
        return saved;
      } finally {
        savingSwitch = false;
        for (const peer of peers) peer.disabled = false;
      }
    });
    return control;
  }

  function renderBuiltins() {
    const plugins = snapshot().plugins.filter((plugin) => !plugin.external);
    const focused = (document.activeElement as HTMLElement)?.dataset.pluginToggle;
    builtinList.replaceChildren(
      ...[
        { title: 'Optional plugins', plugins: plugins.filter(optional), toggle: true },
        { title: 'Core plugins', plugins: plugins.filter((plugin) => !optional(plugin)), toggle: false },
      ].map((group) => {
        const list = fromMarkup('<div class="builtin-group"><h4></h4></div>');
        required(list.querySelector('h4')).textContent = group.title;
        for (const plugin of group.plugins) {
          const row = fromMarkup(
            '<div class="builtin-row"><div><strong></strong><small></small></div></div>',
          );
          required(row.querySelector('strong')).textContent = plugin.title;
          required(row.querySelector('small')).textContent = plugin.description;
          if (group.toggle) row.append(switchFor(plugin, builtinStatus));
          list.append(row);
        }
        return list;
      }),
    );
    if (focused) builtinList.querySelector<HTMLElement>('[data-plugin-toggle="' + focused + '"]')?.focus();
  }

  function render() {
    const focused = document.activeElement as HTMLElement;
    const focusId = focused?.dataset.pluginRow ?? focused?.dataset.pluginToggle;
    const isToggle = focused?.dataset.pluginToggle !== undefined;
    detailLifetime?.abort();
    detailLifetime = undefined;
    header.hidden = false;
    const { plugins } = snapshot();
    const groups = [
      {
        title: 'Built-in configuration',
        plugins: plugins.filter(
          (plugin) => !plugin.external && (plugin.configForm || registry.hasPlugin(plugin.id)),
        ),
      },
      { title: 'Local plugins', plugins: plugins.filter((plugin) => plugin.external) },
    ];
    content.replaceChildren(
      ...groups.map((group) => {
        const list = fromMarkup('<section class="catalog-group"><h2></h2></section>');
        required(list.querySelector('h2')).textContent = group.title;
        if (!group.plugins.length) list.append(fromMarkup('<p class="hint">No plugins available.</p>'));
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
          required(row.querySelector('small')).textContent = plugin.error ?? plugin.description;
          if (plugin.external)
            required(row.querySelector('.catalog-controls')).append(switchFor(plugin, status));
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
  entry.onclick = () => {
    status.textContent = '';
    render();
    pages.open('plugins');
  };
  registry.onPluginChange(() => {
    if (!detailLifetime) render();
  }, ctx.fiber.signal);
  render();
  renderBuiltins();
  return {
    refresh: () => {
      if (savingSwitch) return;
      if (!detailLifetime) render();
      renderBuiltins();
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
    'miniSlots',
  ],
  provide: [],
  apply: setup,
};
