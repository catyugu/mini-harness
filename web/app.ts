import type { Settings } from '../src/config.js';
import type { Bootstrap } from './types.js';
import { data, element, setWorkspace } from './api.js';
import { FrontendHost } from './extensions.js';
import { createPluginLoader } from './plugin-loader.js';
import { createShell } from './shell.js';
import { conversationView } from './conversation.js';
import { sessionNavigation } from './navigation.js';
import { mountSettings, createSettings } from './settings.js';
import { workspacePicker } from './workspaces.js';
import { providerManager } from './provider-manager.js';
import { installForm, pluginCatalog } from './plugin-manager.js';
import { hydrateIcons } from './icons.js';

const shell = createShell();

async function start() {
  let bootstrap = await data<Bootstrap>('/bootstrap');
  setWorkspace(bootstrap.workspace);
  let conversation: ReturnType<typeof conversationView>;
  let navigation: ReturnType<typeof sessionNavigation>;
  let settings: ReturnType<typeof mountSettings>;
  let settingsForm: ReturnType<typeof createSettings>;
  let providerEditor: ReturnType<typeof providerManager>;
  let catalog: ReturnType<typeof pluginCatalog>;
  let placeWorkspace: ReturnType<typeof workspacePicker>;
  let frontendWork = Promise.resolve();
  const report = (error: Error) => conversation?.report(error);
  const host = new FrontendHost(shell.slot, { request: data, insert: (text) => conversation.insert(text), inspect: shell.inspect },
    {
      bootstrap: () => bootstrap,
      sessionTitle: (id) => navigation.title(id),
      openConversation: (id) => { shell.showPage(); void conversation.activate(id); },
      changedFiles: () => conversation.changedFiles(),
      report
    },
    (title, content) => settings.addPage(title, content),
    (command) => conversation.command(command),
    (trigger, complete) => conversation.completion(trigger, complete));
  const loadPlugins = createPluginLoader(host, report);

  function applySettings(updated: Settings) {
    bootstrap.settings = updated;
    document.documentElement.dataset.theme = updated.appearance;
    conversation.updateModelControls();
    frontendWork = loadPlugins(bootstrap);
  }
  async function refresh() {
    bootstrap = await data<Bootstrap>('/bootstrap');
    navigation.update(bootstrap.sessions);
    applySettings(bootstrap.settings);
    settingsForm.fillSettings();
    await frontendWork;
    catalog?.refresh();
  }

  await host.enable('core:workspace', (api) => { placeWorkspace = workspacePicker(api, bootstrap.workspace); });
  await host.enable('core:navigation', (api) => {
    navigation = sessionNavigation(api, {
      active: () => conversation?.active(),
      activate: (id) => { shell.showPage(); void conversation.activate(id); },
      clearConversation: () => conversation.clear(),
      report
    });
  });
  await host.enable('core:conversation', (api) => {
    conversation = conversationView(api, {
      bootstrap: () => bootstrap, applySettings, closeDrawer: shell.closeDrawer,
      renderSessions: navigation.render, syncSessions: navigation.sync, reveal: navigation.reveal,
      addSession: navigation.add, exportSessions: navigation.export, placeWorkspace,
      renderTool: (tool, action) => host.render(tool, action)
    });
    conversation.registerCoreCommands(api.command);
    element('newSession').onclick = () => { shell.showPage(); void conversation.newSession(); };
    const queueTimer = setInterval(() => {
      if (!document.hidden && conversation.sending() && conversation.active()) void conversation.refreshQueue();
    }, 1500);
    api.onDispose(() => clearInterval(queueTimer));
  });
  await host.enable('core:settings', (api) => {
    settings = mountSettings(api);
    settingsForm = createSettings(() => bootstrap, applySettings, refresh, shell.closeDrawer, async () => {
      await frontendWork;
      const active = conversation.active();
      if (active && !conversation.sending()) await conversation.activate(active);
    }, settings.open, () => providerEditor?.render());
  });
  await host.enable('core:providers', () => {
    providerEditor = providerManager(() => bootstrap.providers, refresh);
    return providerEditor.dispose;
  });
  await host.enable('core:plugins', (api) => {
    const installer = installForm(api, refresh);
    element('installPluginSettings').append(installer);
    api.onDispose(() => installer.remove());
    catalog = pluginCatalog(api, () => bootstrap, refresh, shell.showPage);
  });
  hydrateIcons();
  applySettings(bootstrap.settings);
  await frontendWork;
  element('workspaceGroup').title = bootstrap.workspace;
  navigation.update(bootstrap.sessions);
  const remembered = sessionStorage.getItem('mini-harness-active:' + bootstrap.workspace);
  const initial = bootstrap.sessions.find((item) => item.id === remembered) ?? bootstrap.sessions.find((item) => !item.parentId) ?? bootstrap.sessions[0];
  if (initial) void conversation.activate(initial.id);
  else conversation.showConversation();
  if (!bootstrap.models.some((model) => model.configured)) {
    settingsForm.fillSettings();
    settings.open(true);
    element('settingsStatus').textContent = 'Choose a provider and model, then save an API key to start.';
  }
}

void start().catch((error: Error) => {
  const status = element('startupStatus');
  status.hidden = false;
  status.textContent = error.message;
});
