import { Context } from './vendor/cordis.js';
import { data, scopedElements } from './api.js';
import { BrowserState } from './client.js';
import { FrontendHost, type BrowserPlugin, type Slot } from './extensions.js';
import { createPluginLoader } from './plugin-loader.js';
import { shellPlugin } from './shell.js';
import { conversationView } from './conversation.js';
import { sessionNavigation } from './navigation.js';
import { mountSettings, createSettings } from './settings.js';
import { workspacePlugin } from './workspaces.js';
import { providerManager } from './provider-manager.js';
import { installForm, pluginCatalog } from './plugin-manager.js';
import { hydrateIcons } from './icons.js';
import type { Bootstrap } from './types.js';

declare module 'cordis' {
  interface Context {
    miniState: BrowserState;
    miniHost: FrontendHost;
    miniNavigation: ReturnType<typeof sessionNavigation>;
    miniConversation: ReturnType<typeof conversationView>;
    miniSettings: ReturnType<typeof mountSettings>;
    miniEvents: EventTarget;
    miniOutlets: Map<Slot, HTMLElement>;
    miniSwitch: (snapshot: Bootstrap) => Promise<void>;
  }
}

const navigationPlugin: BrowserPlugin = {
  id: 'core:navigation', inject: ['miniState', 'miniShell', 'miniEvents'],
  setup(ctx, api) {
    const { miniShell: shell, miniState: state, miniEvents: events } = ctx;
    const navigation = sessionNavigation(api, {
      active: () => state.activeConversation,
      activate: (id) => events.dispatchEvent(new CustomEvent('open', { detail: id })),
      clearConversation: () => events.dispatchEvent(new Event('clear')),
      changed: () => events.dispatchEvent(new Event('change')),
      setTitle: shell.setTitle,
      report: (error) => events.dispatchEvent(new CustomEvent('error', { detail: error }))
    });
    state.on('bootstrap', () => navigation.update(state.get().sessions), api.signal);
    navigation.update(state.get().sessions);
    ctx.provide('miniNavigation', navigation);
  }
};

const conversationPlugin: BrowserPlugin = {
  id: 'core:conversation', inject: ['miniState', 'miniShell', 'miniEvents', 'miniWorkspace', 'miniNavigation', 'miniHost', 'miniOutlets'],
  setup(ctx, api) {
    const { miniState: state, miniNavigation: navigation, miniShell: shell, miniEvents: events, miniWorkspace: workspace } = ctx;
    const conversation = conversationView(api, {
      bootstrap: state.get, applySettings: state.apply, closeDrawer: shell.closeDrawer,
      setActive: (id) => { state.activeConversation = id; },
      renderSessions: navigation.render, syncSessions: navigation.sync, reveal: navigation.reveal,
      addSession: navigation.add, exportSessions: navigation.export,
      placeWorkspace(welcome) {
        if (welcome) welcome.append(workspace);
        else shell.placeWorkspace(workspace);
      },
      changed: () => events.dispatchEvent(new Event('change')),
      setTitle: shell.setTitle, renderTool: (tool, action) => ctx.miniHost.render(tool, action),
      provideSlot(name, node) {
        ctx.miniOutlets.set(name, node);
        api.onDispose(() => { ctx.miniOutlets.delete(name); });
      }
    });
    ctx.provide('miniConversation', conversation);
    conversation.registerCoreCommands(api.command);
    state.on('settings', conversation.updateModelControls, api.signal);
    shell.bindNew(() => { shell.showPage(); void conversation.newSession(); }, api.signal);
    events.addEventListener('open', (event: CustomEvent<string>) => {
      shell.showPage(); void conversation.activate(event.detail);
    }, { signal: api.signal });
    events.addEventListener('clear', conversation.clear, { signal: api.signal });
    events.addEventListener('error', (event: CustomEvent<Error>) => conversation.report(event.detail), { signal: api.signal });
    const timer = setInterval(() => {
      if (!document.hidden && conversation.sending() && conversation.active()) void conversation.refreshQueue();
    }, 1500);
    api.onDispose(() => clearInterval(timer));
    const { workspace: path, sessions } = state.get();
    const remembered = sessionStorage.getItem('mini-harness-active:' + path);
    const initial = sessions.find(({ id }) => id === remembered) ?? sessions.find(({ parentId }) => !parentId) ?? sessions[0];
    if (initial) void conversation.activate(initial.id);
    else conversation.showConversation();
  }
};

const settingsPlugin: BrowserPlugin = {
  id: 'core:settings', inject: ['miniState', 'miniShell', 'miniConversation', 'miniOutlets', 'miniSwitch'],
  setup(ctx, api) {
    const { miniShell: shell, miniState: state, miniConversation: conversation } = ctx;
    const settings = mountSettings(api);
    ctx.miniOutlets.set('settings', settings.outlet);
    api.onDispose(() => { ctx.miniOutlets.delete('settings'); });
    ctx.provide('miniSettings', settings);
    const refresh = async () => { await state.refresh(); await ctx.miniSwitch(state.get()); };
    const form = createSettings(settings.panel, state.get, state.apply, refresh, shell.closeDrawer, async () => {
      await ctx.miniSwitch(state.get());
      const active = conversation.active();
      if (active && !conversation.sending()) await conversation.activate(active);
    }, (open) => shell.bindSettings(open, api.signal), settings.open, () => state.dispatchEvent(new Event('providers')));
    state.on('bootstrap', form.fillSettings, api.signal);
    if (!state.get().models.some((model) => model.configured)) {
      form.fillSettings();
      settings.open(true);
      scopedElements(settings.panel).element('settingsStatus').textContent = 'Add a model provider to start.';
    }
  }
};

const modelPlugin: BrowserPlugin = {
  id: 'core:models', inject: ['miniSettings', 'miniState'],
  setup(ctx, api) {
    const editor = providerManager(ctx.miniSettings.panel, () => ctx.miniState.get().providers, ctx.miniState.refresh);
    ctx.miniState.addEventListener('providers', editor.render, { signal: api.signal });
    return editor.dispose;
  }
};

const catalogPlugin: BrowserPlugin = {
  id: 'core:plugins', inject: ['miniSettings', 'miniState', 'miniShell', 'miniSwitch'],
  setup(ctx, api) {
    const { miniSettings: settings, miniState: state, miniShell: shell } = ctx;
    const refresh = async () => { await state.refresh(); await ctx.miniSwitch(state.get()); };
    const installer = installForm(api, refresh);
    scopedElements(settings.panel).element('installPluginSettings').append(installer);
    api.onDispose(() => installer.remove());
    const catalog = pluginCatalog(api, state.get, refresh, shell.showPage);
    state.on('bootstrap', catalog.refresh, api.signal);
  }
};

const plugins = [shellPlugin, workspacePlugin, navigationPlugin, conversationPlugin, settingsPlugin, modelPlugin, catalogPlugin];

export async function mountBrowser(ctx: Context, snapshot: Bootstrap) {
  const lifetime = new AbortController();
  const state = new BrowserState(snapshot);
  const events = new EventTarget();
  const slots = new Map<Slot, HTMLElement>();
  const report = (error: Error) => ctx.miniConversation?.report(error);
  const host = new FrontendHost(ctx, (name) => slots.get(name) ?? ctx.miniShell.slot(name),
    { request: data, insert: (text) => ctx.miniConversation.insert(text), inspect: (title, node) => ctx.miniShell.inspect(title, node) },
    {
      bootstrap: state.get,
      sessionTitle: (id) => ctx.miniNavigation.session(id)?.title,
      currentConversation: () => ctx.miniNavigation.session(ctx.miniConversation.active()),
      session: (id) => ctx.miniNavigation.session(id),
      onConversationChange: (listener, signal) => events.addEventListener('change', listener, { signal }),
      openConversation: (id) => { events.dispatchEvent(new CustomEvent('open', { detail: id })); },
      changedFiles: () => ctx.miniConversation.changedFiles(),
      report
    },
    (title, node) => ctx.miniSettings.addPage(title, node),
    (command) => ctx.miniConversation.command(command),
    (trigger, complete) => ctx.miniConversation.completion(trigger, complete));
  const load = createPluginLoader(host, report);
  ctx.provide('miniState', state);
  ctx.provide('miniHost', host);
  ctx.provide('miniEvents', events);
  ctx.provide('miniOutlets', slots);
  ctx.provide('miniSwitch', load);
  try {
    for (const plugin of plugins) await host.mountPlugin(plugin);
    await load(state.get());
    state.on('settings', () => { void load(state.get()); }, lifetime.signal);
    hydrateIcons();
  } catch (error) {
    lifetime.abort();
    await host.dispose();
    throw error;
  }
  return async () => { lifetime.abort(); await host.dispose(); };
}
