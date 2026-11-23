import type { BrowserPlugin } from '../../../web/kernel/extensions.js';
import { conversationView } from './view.js';

export const conversationPlugin: BrowserPlugin = {
  id: 'core:conversation', inject: ['miniState', 'miniLayout', 'miniPages', 'miniHeader', 'miniWorkspace', 'miniHost'],
  setup(ctx, api) {
    const { miniState: state, miniLayout: layout, miniPages: pages, miniHeader: header, miniWorkspace: workspace, miniHost: host } = ctx;
    const conversation = conversationView(api, state, {
      closeDrawer: layout.closeDrawer,
      placeWorkspace(welcome) {
        if (welcome) welcome.append(workspace.current);
        else header.placeWorkspace(workspace.current);
      },
      setTitle: header.setTitle, renderTool: (tool, action) => host.render(tool, action),
      messageActions: () => host.messageActions()
    });
    ctx.provide('miniConversation', conversation);
    ctx.provide('miniComposer', {
      insert: conversation.insert,
      beginDraftMode: conversation.beginDraftMode,
      cancelDraftMode: conversation.cancelDraftMode,
      command: conversation.command,
      completion: conversation.completion,
      refreshTools: conversation.refreshTools
    });
    api.slots.define('conversation.composer', conversation.outlets.composer);
    api.slots.define('conversation.approvals', conversation.outlets.approvals);
    conversation.attach();
    api.onDispose(host.onMessageActionsChanged(conversation.refreshActions));
    state.on('settings', conversation.updateModelControls, api.signal);
    state.addEventListener('plugins', conversation.refreshTools, { signal: api.signal });
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
    const initial = state.initialConversation();
    if (initial) void conversation.activate(initial.id, false);
    else conversation.showConversation();
  }
};


export default conversationPlugin;
