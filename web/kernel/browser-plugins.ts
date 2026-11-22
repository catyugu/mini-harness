import { Context } from '../vendor/cordis.js';
import { data } from '../api.js';
import { BrowserState } from '../models/browser-state.js';
import { FrontendHost, type BrowserPlugin } from './extensions.js';
import { createPluginLoader, type BrowserPluginFailures } from './plugin-loader.js';
import { shellPlugin } from '../shell.js';
import { conversationView } from '../ui/conversation.js';
import { sessionNavigation } from '../ui/navigation.js';
import { settingsPlugin } from '../ui/settings.js';
import { workspacePlugin } from '../ui/workspaces.js';
import { modelPlugin } from '../ui/provider-manager.js';
import { catalogPlugin } from '../ui/plugin-manager.js';
import { hydrateIcons } from '../icons.js';
import type { Bootstrap } from '../types.js';

declare module 'cordis' {
  interface Context {
    miniState: BrowserState;
    miniHost: FrontendHost;
    miniConversation: ReturnType<typeof conversationView>;
    miniSwitch: (snapshot: Bootstrap) => Promise<BrowserPluginFailures>;
  }
}

const navigationPlugin: BrowserPlugin = {
  id: 'core:navigation', inject: ['miniState', 'miniShell', 'miniWorkspace'],
  setup(ctx, api) {
    const { miniShell: shell, miniState: state, miniWorkspace: workspace } = ctx;
    sessionNavigation(api, {
      state,
      select(id, draft) {
        const changed = state.selectedWorkspace !== id;
        state.selectWorkspace(id);
        shell.showPage();
        if (draft || changed) state.dispatchEvent(new Event(draft ? 'draft' : 'clear'));
        else state.changed();
        if (!draft) shell.closeDrawer();
      },
      chooseWorkspace: (onAdd) => workspace.open(state.workspace(), onAdd),
      renameWorkspace: workspace.rename,
      removeWorkspace: workspace.remove,
      activate: (id) => state.dispatchEvent(new CustomEvent('open', { detail: id })),
      clearConversation: () => state.dispatchEvent(new Event('clear')),
      setTitle: shell.setTitle,
      report: (error) => state.dispatchEvent(new CustomEvent('error', { detail: error }))
    });
  }
};

const conversationPlugin: BrowserPlugin = {
  id: 'core:conversation', inject: ['miniState', 'miniShell', 'miniWorkspace', 'miniHost'],
  setup(ctx, api) {
    const { miniState: state, miniShell: shell, miniWorkspace: workspace, miniHost: host } = ctx;
    const conversation = conversationView(api, state, {
      closeDrawer: shell.closeDrawer,
      placeWorkspace(welcome) {
        if (welcome) welcome.append(workspace.current);
        else shell.placeWorkspace(workspace.current);
      },
      setTitle: shell.setTitle, renderTool: (tool, action) => host.render(tool, action),
      messageActions: () => host.messageActions()
    });
    ctx.provide('miniConversation', conversation);
    conversation.attach();
    api.onDispose(host.onMessageActionsChanged(conversation.refreshActions));
    state.on('settings', conversation.updateModelControls, api.signal);
    shell.bindNew(() => { shell.showPage(); conversation.clear(true); }, api.signal);
    state.addEventListener('open', (event: CustomEvent<string>) => {
      shell.showPage(); void conversation.activate(event.detail);
    }, { signal: api.signal });
    state.addEventListener('clear', () => conversation.clear(), { signal: api.signal });
    state.addEventListener('draft', () => conversation.clear(true), { signal: api.signal });
    state.addEventListener('error', (event: CustomEvent<Error>) => conversation.report(event.detail), { signal: api.signal });
    const initial = state.initialConversation();
    if (initial) void conversation.activate(initial.id, false);
    else conversation.showConversation();
  }
};

const plugins = [shellPlugin, workspacePlugin, navigationPlugin, conversationPlugin, settingsPlugin, modelPlugin, catalogPlugin];

export async function mountBrowser(ctx: Context, snapshot: Bootstrap) {
  const state = new BrowserState(snapshot);
  const report = (error: Error) => ctx.miniConversation?.report(error);
  const host = new FrontendHost(ctx, (name) => {
    switch (name) {
      case 'settings': return ctx.miniSettings.outlet;
      case 'composer':
      case 'approvals': return ctx.miniConversation.outlets[name];
      default: return ctx.miniShell.outlet(name);
    }
  },
    { request: data, insert: (text) => ctx.miniConversation.insert(text),
      beginDraftMode: (mode) => ctx.miniConversation.beginDraftMode(mode),
      cancelDraftMode: () => ctx.miniConversation.cancelDraftMode(), tabs: () => ctx.rightTabs },
    {
      bootstrap: state.get,
      workspace: state.scope,
      session: state.session,
      onConversationChange: (listener, signal) => state.on('navigation', listener, signal),
      openConversation: (id) => { state.dispatchEvent(new CustomEvent('open', { detail: id })); },
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
