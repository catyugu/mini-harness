import { Context } from './vendor/cordis.js';
import { data } from './api.js';
import { BrowserState } from './client.js';
import { FrontendHost, type BrowserPlugin } from './extensions.js';
import { createPluginLoader, type BrowserPluginFailures } from './plugin-loader.js';
import { shellPlugin } from './shell.js';
import { conversationView } from './conversation.js';
import { sessionNavigation } from './navigation.js';
import { settingsPlugin } from './settings.js';
import { workspacePlugin } from './workspaces.js';
import { modelPlugin } from './provider-manager.js';
import { catalogPlugin } from './plugin-manager.js';
import { hydrateIcons } from './icons.js';
import type { Bootstrap } from './types.js';

declare module 'cordis' {
  interface Context {
    miniState: BrowserState;
    miniHost: FrontendHost;
    miniNavigation: ReturnType<typeof sessionNavigation>;
    miniConversation: ReturnType<typeof conversationView>;
    miniEvents: EventTarget;
    miniSwitch: (snapshot: Bootstrap) => Promise<BrowserPluginFailures>;
  }
}

const navigationPlugin: BrowserPlugin = {
  id: 'core:navigation', inject: ['miniState', 'miniShell', 'miniEvents', 'miniWorkspace'],
  setup(ctx, api) {
    const { miniShell: shell, miniState: state, miniEvents: events } = ctx;
    const navigation = sessionNavigation(api, {
      state,
      select(id, draft) {
        const changed = state.selectedWorkspace !== id;
        state.selectWorkspace(id);
        shell.showPage();
        if (draft || changed) events.dispatchEvent(new Event(draft ? 'draft' : 'clear'));
        else navigation.render();
        if (!draft) shell.closeDrawer();
      },
      chooseWorkspace: (onAdd) => ctx.miniWorkspace.open(state.get().workspaces.find(({ id }) => id === state.selectedWorkspace), onAdd),
      manageWorkspace: (record) => ctx.miniWorkspace.manage(record),
      activate: (id) => events.dispatchEvent(new CustomEvent('open', { detail: id })),
      clearConversation: () => events.dispatchEvent(new Event('clear')),
      changed: () => events.dispatchEvent(new Event('change')),
      setTitle: shell.setTitle,
      report: (error) => events.dispatchEvent(new CustomEvent('error', { detail: error }))
    });
    ctx.provide('miniNavigation', navigation);
  }
};

const conversationPlugin: BrowserPlugin = {
  id: 'core:conversation', inject: ['miniState', 'miniShell', 'miniEvents', 'miniWorkspace', 'miniNavigation', 'miniHost'],
  setup(ctx, api) {
    const { miniState: state, miniNavigation: navigation, miniShell: shell, miniEvents: events, miniWorkspace: workspace } = ctx;
    const conversation = conversationView(api, {
      bootstrap: state.get,
      applySettings: state.apply, closeDrawer: shell.closeDrawer,
      setActive(item) {
        state.activeConversation = item?.id;
        if (item) state.selectWorkspace(item.workspaceId);
      },
      workspace: () => state.selectedWorkspace,
      renderSessions: navigation.render, reveal: navigation.reveal,
      addSession: navigation.add, exportSessions: navigation.export,
      placeWorkspace(welcome) {
        if (welcome) welcome.append(workspace.current);
        else shell.placeWorkspace(workspace.current);
      },
      changed: () => events.dispatchEvent(new Event('change')),
      setTitle: shell.setTitle, renderTool: (tool, action) => ctx.miniHost.render(tool, action)
    });
    ctx.provide('miniConversation', conversation);
    conversation.attach();
    conversation.registerCoreCommands(api.command);
    state.on('settings', conversation.updateModelControls, api.signal);
    shell.bindNew(() => { shell.showPage(); void conversation.newSession(); }, api.signal);
    events.addEventListener('open', (event: CustomEvent<string>) => {
      shell.showPage(); void conversation.activate(event.detail);
    }, { signal: api.signal });
    events.addEventListener('clear', conversation.clear, { signal: api.signal });
    events.addEventListener('draft', () => void conversation.newSession(), { signal: api.signal });
    events.addEventListener('error', (event: CustomEvent<Error>) => conversation.report(event.detail), { signal: api.signal });
    const timer = setInterval(() => {
      if (!document.hidden && conversation.sending() && conversation.active()) void conversation.refreshQueue();
    }, 1500);
    api.onDispose(() => clearInterval(timer));
    const { sessions, workspaces } = state.get();
    const current = workspaces.find(({ id }) => id === state.selectedWorkspace);
    const remembered = sessionStorage.getItem('mini-harness-active') ?? sessionStorage.getItem('mini-harness-active:' + current?.path);
    const available = sessions.filter(({ workspaceId }) => workspaces.some(({ id }) => id === workspaceId));
    const initial = available.find(({ id }) => id === remembered) ??
      available.find(({ parentId, workspaceId }) => !parentId && workspaceId === current?.id);
    if (initial) void conversation.activate(initial.id, false);
    else conversation.showConversation();
  }
};

const plugins = [shellPlugin, workspacePlugin, navigationPlugin, conversationPlugin, settingsPlugin, modelPlugin, catalogPlugin];

export async function mountBrowser(ctx: Context, snapshot: Bootstrap) {
  const state = new BrowserState(snapshot);
  const events = new EventTarget();
  const report = (error: Error) => ctx.miniConversation?.report(error);
  function scope() {
    const workspaceId = state.selectedWorkspace;
    return workspaceId && { workspaceId, sessionId: state.activeConversation };
  }
  events.addEventListener('change', () => {
    const { workspaces, sessions } = state.get();
    ctx.miniWorkspace.label(workspaces.find(({ id }) => id === state.selectedWorkspace));
    ctx.rightTabs.selectScope(scope());
    ctx.rightTabs.prune(new Set(sessions.map(({ id }) => id)), new Set(workspaces.map(({ id }) => id)));
  });
  const host = new FrontendHost(ctx, (name) => {
    switch (name) {
      case 'settings': return ctx.miniSettings.outlet;
      case 'composer':
      case 'approvals': return ctx.miniConversation.outlets[name];
      default: return ctx.miniShell.outlet(name);
    }
  },
    { request: data, insert: (text) => ctx.miniConversation.insert(text), tabs: () => ctx.rightTabs },
    {
      bootstrap: state.get,
      workspace: scope,
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
  const sync = createPluginLoader(host);
  const load = async (snapshot: Bootstrap) => {
    const failures = await sync(snapshot);
    ctx.miniConversation.refreshTools();
    return failures;
  };
  ctx.provide('miniState', state);
  ctx.provide('miniHost', host);
  ctx.provide('miniEvents', events);
  ctx.provide('miniSwitch', load);
  try {
    for (const plugin of plugins) await host.mountPlugin(plugin);
    const failures = await load(state.get());
    if (failures.size) report(new Error('Browser plugins failed: ' + [...failures.keys()].join(', ')));
    hydrateIcons();
  } catch (error) {
    await host.dispose();
    throw error;
  }
  return () => host.dispose();
}
