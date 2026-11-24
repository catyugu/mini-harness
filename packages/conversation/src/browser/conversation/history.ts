import type { Context } from 'cordis';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageExtensions } from './message-extensions.js';
import { createMessageView } from './messages.js';

export function mountHistory(ctx: Context, extensions: MessageExtensions, signal: AbortSignal) {
  const control = ctx.miniConversation;
  const messages = document.createElement('section');
  messages.id = 'messages'; messages.className = 'messages'; messages.setAttribute('aria-label', 'Messages');
  const view = createMessageView(ctx.miniDialogs, signal, messages, {
    render: (tool, lifetime, action) => extensions.render(tool, lifetime, action),
    messageActions: () => extensions.actionsForMessage(),
    report: extensions.report
  }, () => ({ sessionId: control.get().session?.id, leafId: control.get().history.leafId }),
  () => void ctx.miniComposer.retry().catch(control.report));
  const records = new Map<string, { record: SessionDisplayRecord; render?: ReturnType<typeof extensions.recordRenderer>;
    node: HTMLElement; lifetime: AbortController }>();
  signal.addEventListener('abort', () => { for (const item of records.values()) item.lifetime.abort(); records.clear(); }, { once: true });
  let sessionId: string | undefined;
  function render() {
    const { session, history, run } = control.get();
    const reset = session?.id !== sessionId;
    sessionId = session?.id;
    const active = new Set(history.records.map(({ id }) => id));
    for (const [id, item] of records) if (reset || !active.has(id)) { item.lifetime.abort(); records.delete(id); }
    const nodes = sessionId ? history.records.map((record) => {
      const render = extensions.recordRenderer(record.plugin);
      const prior = records.get(record.id);
      if (prior && prior.render === render && (prior.record === record || JSON.stringify(prior.record) === JSON.stringify(record))) return prior;
      prior?.lifetime.abort();
      const lifetime = new AbortController();
      const node = document.createElement('div');
      node.className = 'conversation-record';
      node.dataset.conversationRecord = record.id;
      const rendered = extensions.renderRecord(render, record, { sessionId: sessionId!, signal: lifetime.signal });
      if (rendered) node.append(rendered);
      else { const fallback = document.createElement('p'); fallback.className = 'hint'; fallback.textContent = record.title; node.append(fallback); }
      const item = { record, render, node, lifetime };
      records.set(record.id, item);
      return item;
    }) : [];
    view.history(history.messages, nodes, run?.state === 'failed' ? run.error : undefined, reset);
  }
  extensions.subscribe(view.refreshActions, signal);
  extensions.subscribeToTools(view.refreshTools, signal);
  extensions.subscribeToRecords(render, signal);
  control.subscribe(['session', 'history', 'run'], render, signal);
  control.subscribe(['partial'], () => view.partial(control.get().partial), signal);
  control.subscribe(['tools'], () => view.activity(control.get().tools), signal);
  render();
  view.partial(control.get().partial);
  view.activity(control.get().tools);
  return messages;
}
