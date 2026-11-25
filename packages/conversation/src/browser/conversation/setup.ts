import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import type { Context } from 'mini-harness/cordis';
import { createConversationController } from './controller.ts';
import { fromMarkup, required, toggle } from '@mini-harness/ui-primitives/primitives';
import { mountApprovals } from './approval-panel.ts';
import { mountConversationLayout } from './view.ts';

const setup = (ctx: Context) => {
  const signal = ctx.fiber.signal;
  const {
    miniSelection: state,
    miniSessions: sessions,
    miniWorkspaces: workspaces,
    miniLayout: layout,
    miniPages: pages,
  } = ctx;
  ctx.effect(() =>
    ctx.miniSettingsRegistry.register(
      browserPluginId(ctx),
      {
        id: 'queue-mode',
        section: { title: 'General', icon: 'settings', order: 20 },
        render({ bind }) {
          const content = fromMarkup(
            '<div class="settings-preference"><label class="switch-line"><span><strong>Add instructions</strong><small>When a response is running, queued messages steer the current task. Turn off to send them after the response as follow-ups.</small></span></label></div>',
          );
          const control = toggle('Add instructions', false);
          required(content.querySelector('label')).append(control);
          content.append(
            bind<'steer' | 'followUp'>(control, 'queueMode', {
              read: (value) => {
                control.checked = value === 'steer';
              },
              write: () => (control.checked ? 'steer' : 'followUp'),
            }),
          );
          return content;
        },
      },
      browserPluginSettings(ctx),
    ),
  );
  const conversation = createConversationController(ctx);
  ctx.provide('miniConversation', conversation);
  mountConversationLayout(ctx);
  mountApprovals(ctx);
  function clearDraft() {
    conversation.clear();
    layout.closeDrawer();
    state.dispatchEvent(new Event('focus-composer'));
  }
  ctx.effect(() =>
    ctx.miniSlots.registerKeyed(
      'sidebar.primary',
      'new-conversation',
      (signal) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'new-session';
        button.setAttribute('aria-label', 'New conversation');
        button.innerHTML = '<span data-icon="plus"></span><span class="nav-label">New conversation</span>';
        button.addEventListener(
          'click',
          () => {
            pages.open();
            clearDraft();
          },
          { signal },
        );
        return button;
      },
      { order: -1 },
    ),
  );
  state.addEventListener(
    'open',
    (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
      pages.open();
      void conversation.activate(event.detail).then((activated) => {
        if (activated) layout.closeDrawer();
      });
    },
    { signal },
  );
  state.addEventListener('clear', () => conversation.clear(), { signal });
  state.addEventListener('draft', () => clearDraft(), { signal });
  state.addEventListener(
    'error',
    (event: Event) => {
      if (event instanceof CustomEvent && event.detail instanceof Error) conversation.report(event.detail);
    },
    { signal },
  );
  const initial = state.initialConversation(sessions.get(), workspaces.get());
  if (initial) void conversation.activate(initial.id, false);
  else conversation.clear();
};

export default {
  inject: [
    'miniSelection',
    'miniApprovals',
    'harnessBrowser',
    'miniSessions',
    'miniWorkspaces',
    'miniLayout',
    'miniPages',
    'miniHeader',
    'miniProjections',
    'miniSlots',
    'miniSettingsRegistry',
  ],
  provide: ['miniConversation'],
  apply: setup,
};
