import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import type { Context } from 'mini-harness/cordis';
import { messageModes, type MessageMode } from '@mini-harness/sessions/queue';
import { modeLabel } from './queue-view.ts';
import { createConversationController } from './controller.ts';
import { fromMarkup, required } from '@mini-harness/ui-primitives/primitives';
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
        id: 'message-mode',
        section: { title: 'General', icon: 'settings', order: 10 },
        render({ bind }) {
          const content = fromMarkup(
            '<div class="settings-preference"><label class="switch-line"><span><strong>Add instructions</strong><small>Default sending mode for conversations without a selection.</small></span></label></div>',
          );
          const control = document.createElement('select');
          control.setAttribute('aria-label', 'Add instructions');
          for (const mode of messageModes) control.add(new Option(modeLabel[mode], mode));
          required(content.querySelector('label')).append(control);
          content.append(
            bind<MessageMode>(control, 'messageMode', {
              read: (value) => {
                control.value = value;
              },
              write: () => control.value as MessageMode,
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
    ctx.miniSlots.register(
      'sidebar.primary',
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
      { key: 'new-conversation', order: -1 },
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
