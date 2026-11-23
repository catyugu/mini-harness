import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';
import { MessageExtensions } from '@mini-harness/ui-runtime/message-extensions';
import { conversationView } from './view.js';

const setup: FrontendSetup = (ctx, api) => {
  const { miniSelection: state, miniSessions: sessions, miniWorkspaces: workspaces, miniSettingsData: settings, miniModels: models, miniLayout: layout, miniPages: pages, miniHeader: header } = ctx;
  const extensions = new MessageExtensions((error) => state.dispatchEvent(new CustomEvent('error', { detail: error })));
  ctx.provide('miniMessages', extensions);
  const conversation = conversationView(api, state, {
    sessions, settings, models,
    closeDrawer: layout.closeDrawer,
    showWorkspaceInHeader: header.showWorkspace,
    setTitle: header.setTitle, renderTool: (tool, action) => extensions.render(tool, action),
    messageActions: () => extensions.actionsForMessage()
  });
  ctx.provide('miniComposer', {
    insert: conversation.insert,
    beginDraftMode: conversation.beginDraftMode,
    cancelDraftMode: conversation.cancelDraftMode,
    command: conversation.command,
    completion: conversation.completion
  });
  api.slots.define('conversation.composer', conversation.outlets.composer);
  api.slots.define('conversation.approvals', conversation.outlets.approvals);
  api.slots.define('workspace.welcome', conversation.outlets.workspace, 'single');
  conversation.attach();
  extensions.subscribe(conversation.refreshActions, api.signal);
  settings.subscribe(conversation.updateModelControls, api.signal);
  models.subscribe(conversation.updateModelControls, api.signal);
  extensions.subscribeToTools(conversation.refreshTools, api.signal);
  api.slots.registerKeyed('sidebar.primary', 'new-conversation', (signal) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'new-session';
    button.setAttribute('aria-label', 'New conversation');
    button.innerHTML = '<span data-icon="plus"></span><span class="nav-label">New conversation</span>';
    button.addEventListener('click', () => { pages.open(); conversation.clear(true); }, { signal });
    return button;
  });
  state.addEventListener('open', (event: CustomEvent<string>) => {
    pages.open(); void conversation.activate(event.detail);
  }, { signal: api.signal });
  state.addEventListener('clear', () => conversation.clear(), { signal: api.signal });
  state.addEventListener('draft', () => conversation.clear(true), { signal: api.signal });
  state.addEventListener('error', (event: CustomEvent<Error>) => conversation.report(event.detail), { signal: api.signal });
  const initial = state.initialConversation(sessions.get(), workspaces.get());
  if (initial) void conversation.activate(initial.id, false);
  else conversation.showConversation();
};


export default setup;
