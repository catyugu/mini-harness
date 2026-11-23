import type { BrowserPlugin } from '../../../web/kernel/extensions.js';
import { conversationView } from './view.js';

export const conversationPlugin: BrowserPlugin = {
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
    ctx.provide('miniComposer', {
      insert: conversation.insert,
      beginDraftMode: conversation.beginDraftMode,
      cancelDraftMode: conversation.cancelDraftMode,
      command: conversation.command,
      completion: conversation.completion,
      refreshTools: conversation.refreshTools
    });
    api.outlet('composer', conversation.outlets.composer);
    api.outlet('approvals', conversation.outlets.approvals);
    conversation.attach();
    api.onDispose(host.onMessageActionsChanged(conversation.refreshActions));
    state.on('settings', conversation.updateModelControls, api.signal);
    state.addEventListener('plugins', conversation.refreshTools, { signal: api.signal });
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

