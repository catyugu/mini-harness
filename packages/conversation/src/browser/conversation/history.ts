import type { Context } from 'cordis';
import type { ConversationState } from '../composer-api.js';
import type { MessageExtensions } from './message-extensions.js';
import { isRunning } from '@mini-harness/sessions/run-state';
import { createMessageView } from './messages.js';

export function mountHistory(ctx: Context, extensions: MessageExtensions, signal: AbortSignal) {
  const control = ctx.miniConversation;
  const messages = document.createElement('section');
  messages.id = 'messages'; messages.className = 'messages'; messages.setAttribute('aria-label', 'Messages');
  const view = createMessageView(ctx.miniDialogs, signal, messages, {
    render: (tool, action) => extensions.render(tool, action), messageActions: () => extensions.actionsForMessage()
  }, () => ({ sessionId: control.get().conversation?.id, leafId: control.get().view?.leafId }),
  () => void control.retry().catch(control.report));
  let previous: ConversationState | undefined;
  let stream: ReturnType<typeof view.stream> | undefined;
  let records = new AbortController();
  signal.addEventListener('abort', () => records.abort(), { once: true });
  function refreshRecords() {
    records.abort(); records = new AbortController();
    const state = control.get(), sessionId = state.conversation?.id;
    view.placeRecords(sessionId ? state.records.map((record) => {
      const node = document.createElement('div');
      node.className = 'conversation-record';
      const rendered = extensions.renderRecord(record, { sessionId, signal: records.signal });
      if (rendered) node.append(rendered);
      else { const fallback = document.createElement('p'); fallback.className = 'hint'; fallback.textContent = record.title; node.append(fallback); }
      return { record, node };
    }) : [], state.recordMessages);
  }
  function render() {
    const state = control.get();
    const switched = previous?.conversation?.id !== state.conversation?.id;
    const reset = !previous || switched || previous.view !== state.view;
    const start = reset ? 0 : previous?.events.length ?? 0;
    if (reset) {
      view.history(state.view?.messages ?? [], state.view?.run?.state === 'failed' ? state.view.run.error : undefined, switched);
      stream = state.view && isRunning(state.view.run) ? view.stream(state.view) : undefined;
    }
    for (const event of state.events.slice(start)) stream?.(event);
    if (reset || previous?.records !== state.records || previous?.recordMessages !== state.recordMessages) refreshRecords();
    previous = state;
  }
  extensions.subscribe(view.refreshActions, signal);
  extensions.subscribeToTools(view.refreshTools, signal);
  extensions.subscribeToRecords(refreshRecords, signal);
  control.subscribe(render, signal);
  render();
  return messages;
}
