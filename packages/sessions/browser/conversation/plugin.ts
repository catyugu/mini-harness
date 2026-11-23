import type { FrontendSetup } from '../../../ui-runtime/frontend.js';
import { MessageExtensions } from '../../../ui-runtime/message-extensions.js';
import { conversationView } from './view.js';

const setup: FrontendSetup = (ctx, api) => {
  const { miniSelection: state, miniSessions: sessions, miniWorkspaces: workspaces, miniSettingsData: settings, miniModels: models, miniLayout: layout, miniPages: pages, miniHeader: header, miniWorkspace: workspace } = ctx;
  const extensions = new MessageExtensions((error) => state.dispatchEvent(new CustomEvent('error', { detail: error })));
  ctx.provide('miniMessages', extensions);
  const conversation = conversationView(api, state, {
    sessions, settings, models,
    closeDrawer: layout.closeDrawer,
    placeWorkspace(welcome) {
      if (welcome) welcome.append(workspace.current);
      else header.placeWorkspace(workspace.current);
    },
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
  conversation.attach();
  extensions.subscribe(conversation.refreshActions, api.signal);
  settings.subscribe(conversation.updateModelControls, api.signal);
  models.subscribe(conversation.updateModelControls, api.signal);
  extensions.subscribeToTools(conversation.refreshTools, api.signal);
  const newSession = document.createElement('button');
  newSession.type = 'button';
  newSession.className = 'new-session';
  newSession.setAttribute('aria-label', 'New conversation');
  newSession.innerHTML = '<span data-icon="plus"></span><span class="nav-label">New conversation</span>';
  newSession.onclick = () => { pages.open(); conversation.clear(true); };
  api.slots.register('sidebar.primary', newSession);
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
