import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import { payload } from '@mini-harness/ui-runtime/http';

export const mountApprovals = (ctx: Context) => {
  const signal = ctx.fiber.signal;
  const { miniApprovals: approvals, harnessBrowser: services } = ctx;
  const list = document.createElement('div');
  ctx.effect(() => ctx.miniSlots.register('conversation.approvals', list));
  function render() {
    const session = services.session();
    if (!session) {
      list.replaceChildren();
      return;
    }
    list.replaceChildren(
      ...approvals
        .get()
        .filter(({ sessionId }) => sessionId === session.id)
        .map((approval) => {
          const card = document.createElement('section');
          card.className = 'approval-card';
          const title = document.createElement('strong');
          title.textContent = approval.title;
          const command = document.createElement('pre');
          command.textContent = approval.message;
          const origin = document.createElement('small');
          const workspace =
            (session.workspaceId && services.workspaceRecord(session.workspaceId)?.path) || session.title;
          origin.textContent = approval.plugin + ' · ' + workspace;
          const heading = document.createElement('header');
          heading.className = 'approval-heading';
          heading.append(title, origin);
          const actions = document.createElement('div');
          actions.className = 'approval-actions';
          card.append(heading, command, actions);
          for (const allow of [false, true]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'small-button';
            button.textContent = allow ? 'Allow once' : 'Deny';
            button.onclick = async () => {
              if (services.session()?.id !== approval.sessionId) return;
              for (const action of card.querySelectorAll('button')) action.disabled = true;
              try {
                await browserRequest(ctx, '/approvals', payload('POST', { id: approval.id, allow }));
                await approvals.refresh();
              } catch (error) {
                if (!signal.aborted)
                  services.report(error instanceof Error ? error : new Error(String(error)));
                for (const action of card.querySelectorAll('button')) action.disabled = false;
              }
            };
            actions.append(button);
          }
          return card;
        }),
    );
  }
  approvals.subscribe(render, signal);
  services.onConversationChange(render, signal);
  render();
};
