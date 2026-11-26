import type { Context } from 'mini-harness/cordis';
import type { MessageExtensions } from './message-extensions.ts';
import { createMessageView } from './messages.ts';

export function mountHistory(ctx: Context, extensions: MessageExtensions, signal: AbortSignal) {
  const control = ctx.miniConversation;
  const viewport = document.createElement('section');
  viewport.id = 'messages';
  viewport.className = 'messages';
  viewport.setAttribute('aria-label', 'Messages');
  const messages = document.createElement('div');
  messages.className = 'message-list ui-content-width';
  viewport.append(messages);
  const view = createMessageView(
    ctx,
    signal,
    viewport,
    messages,
    extensions,
    () => {
      const { session, history } = control.get();
      return {
        workspaceId: session?.workspaceId ?? undefined,
        sessionId: session?.id,
        leafId: history?.leafId,
      };
    },
    () => void ctx.miniComposer.retry().catch(control.report),
  );

  let selected: string | undefined;
  function render() {
    const { session, history, run, partial, tools } = control.get();
    if (!history || selected !== session?.id) view.reset();
    selected = session?.id;
    if (history) view.history(history.timeline, run, partial, tools);
  }
  extensions.subscribe(view.refreshActions, signal);
  extensions.subscribeToTools(view.refreshTools, signal);
  extensions.subscribeToFooters(render, signal);
  extensions.subscribeToRecords(render, signal);
  control.subscribe(['session', 'history', 'run', 'tools'], render, signal);
  control.subscribe(
    ['partial'],
    () => {
      const { partial } = control.get();
      if (!view.partial(partial)) render();
    },
    signal,
  );
  let operation = control.get().interaction.operation;
  control.subscribe(
    ['interaction'],
    () => {
      const next = control.get().interaction.operation;
      if (operation !== next && next === 'submit') view.follow();
      operation = next;
    },
    signal,
  );
  render();
  return viewport;
}
