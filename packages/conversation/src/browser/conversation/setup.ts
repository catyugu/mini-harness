import type {} from '@mini-harness/workspaces/browser/api';
import type {} from '@mini-harness/models/browser/api';
import type {} from '@mini-harness/ui-layout/browser/api';
import type {} from '@mini-harness/ui-runtime/projection-api';
import { slotExtensions } from '@mini-harness/ui-slots/browser/api';
import { settingsExtensions } from '@mini-harness/settings/browser/api';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';
import { MessageExtensions } from './message-extensions.js';
import { fromMarkup, required, toggle } from '@mini-harness/ui-primitives/primitives';
import { mountApprovals } from './approval-panel.js';
import { conversationView } from './view.js';

const setup: FrontendSetup = (ctx, api) => {
  const { miniSelection: state, miniSessions: sessions, miniWorkspaces: workspaces, miniModels: models, miniLayout: layout, miniPages: pages, miniHeader: header } = ctx;
  api.contribute(settingsExtensions.register, {
    id: 'queue-mode',
    section: { title: 'General', icon: 'settings', order: 20 },
    render({ bind }) {
      const content = fromMarkup('<div class="settings-preference"><label class="switch-line"><span><strong>Add instructions</strong><small>When a response is running, queued messages steer the current task. Turn off to send them after the response as follow-ups.</small></span></label></div>');
      const control = toggle('Add instructions', false);
      required(content.querySelector('label')).append(control);
      content.append(bind<'steer' | 'followUp'>(control, 'queueMode', {
        read: (value) => { control.checked = value === 'steer'; },
        write: () => control.checked ? 'steer' : 'followUp',
      }));
      return content;
    }
  });
  const extensions = new MessageExtensions((error) => state.dispatchEvent(new CustomEvent('error', { detail: error })));
  ctx.provide('miniMessages', extensions);
  const conversation = conversationView(api, state, {
    sessions, models, projections: ctx.miniProjections,
    closeDrawer: layout.closeDrawer,
    showWorkspaceInHeader: header.showWorkspace,
    setTitle: header.setTitle, renderTool: (tool, action) => extensions.render(tool, action),
    messageActions: () => extensions.actionsForMessage(),
    renderRecord: (record, context) => extensions.renderRecord(record, context)
  });
  ctx.provide('miniComposer', {
    insert: conversation.insert,
    beginDraftMode: conversation.beginDraftMode,
    command: conversation.command,
    completion: conversation.completion
  });
  api.contribute(slotExtensions.define, 'conversation.composer', conversation.outlets.composer);
  api.contribute(slotExtensions.define, 'conversation.approvals', conversation.outlets.approvals);
  api.contribute(slotExtensions.define, 'workspace.welcome', conversation.outlets.workspace, 'single');
  mountApprovals(ctx, api);
  conversation.attach();
  extensions.subscribe(conversation.refreshActions, api.signal);
  models.subscribe(conversation.updateModelControls, api.signal);
  extensions.subscribeToRecords(conversation.refreshRecords, api.signal);
  extensions.subscribeToTools(conversation.refreshTools, api.signal);
  api.contribute(slotExtensions.keyed, 'sidebar.primary', 'new-conversation', (signal) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'new-session';
    button.setAttribute('aria-label', 'New conversation');
    button.innerHTML = '<span data-icon="plus"></span><span class="nav-label">New conversation</span>';
    button.addEventListener('click', () => { pages.open(); conversation.clear(true); }, { signal });
    return button;
  });
  state.addEventListener('open', (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
    pages.open(); void conversation.activate(event.detail);
  }, { signal: api.signal });
  state.addEventListener('clear', () => conversation.clear(), { signal: api.signal });
  state.addEventListener('draft', () => conversation.clear(true), { signal: api.signal });
  state.addEventListener('error', (event: Event) => {
    if (event instanceof CustomEvent && event.detail instanceof Error) conversation.report(event.detail);
  }, { signal: api.signal });
  const initial = state.initialConversation(sessions.get(), workspaces.get());
  if (initial) void conversation.activate(initial.id, false);
  else conversation.showConversation();
};


export default setup;
