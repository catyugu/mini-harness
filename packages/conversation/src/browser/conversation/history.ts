import type { Context } from 'mini-harness/cordis';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageExtensions } from './message-extensions.ts';
import { createMessageView } from './messages.ts';

export function mountHistory(ctx: Context, extensions: MessageExtensions, signal: AbortSignal) {
  const control = ctx.miniConversation;
  const viewport = document.createElement('section');
  viewport.id = 'messages';
  viewport.className = 'messages';
  viewport.setAttribute('aria-label', 'Messages');
  const messages = document.createElement('div');
  messages.className = 'message-list';
  viewport.append(messages);
  const view = createMessageView(
    ctx,
    signal,
    viewport,
    messages,
    {
      render: (tool, lifetime, action) => extensions.render(tool, lifetime, action),
      messageActions: () => extensions.actionsForMessage(),
      report: extensions.report,
    },
    () => ({
      workspaceId: control.get().session?.workspaceId ?? undefined,
      sessionId: control.get().session?.id,
      leafId: control.get().history.leafId,
    }),
    () => void ctx.miniComposer.retry().catch(control.report),
  );
  const records = new Map<
    string,
    {
      record: SessionDisplayRecord;
      render?: ReturnType<typeof extensions.recordRenderer>;
      node: HTMLElement;
      lifetime: AbortController;
    }
  >();
  signal.addEventListener(
    'abort',
    () => {
      for (const item of records.values()) item.lifetime.abort();
      records.clear();
    },
    { once: true },
  );
  let previous: ReturnType<typeof control.get> | undefined;
  let loadedSession: string | undefined;
  function render() {
    const state = control.get();
    const { session, history, run, partial, tools } = state;
    const sessionId = session?.id;
    const reset = sessionId !== previous?.session?.id;
    if (reset) loadedSession = undefined;
    const onlyPartial =
      previous?.history === history &&
      previous.session === session &&
      previous.tools === tools &&
      previous.run === run &&
      previous.partial !== partial;
    const firstHistory =
      sessionId !== undefined &&
      loadedSession !== sessionId &&
      (history.leafId !== null || history.terminations.length > 0 || state.interaction.operation !== 'open');
    if (firstHistory) {
      loadedSession = sessionId;
      view.follow();
    }
    previous = state;
    if (onlyPartial && view.partial(partial)) return;
    const active = new Set(history.records.map(({ id }) => id));
    for (const [id, item] of records)
      if (reset || !active.has(id)) {
        item.lifetime.abort();
        records.delete(id);
      }
    const nodes = sessionId
      ? history.records.map((record) => {
          const render = extensions.recordRenderer(record.plugin);
          const prior = records.get(record.id);
          if (
            prior &&
            prior.render === render &&
            (prior.record === record || JSON.stringify(prior.record) === JSON.stringify(record))
          )
            return prior;
          prior?.lifetime.abort();
          const lifetime = new AbortController();
          const node = document.createElement('div');
          node.className = 'conversation-record';
          node.dataset.conversationRecord = record.id;
          const rendered = extensions.renderRecord(render, record, {
            sessionId: sessionId!,
            signal: lifetime.signal,
          });
          if (rendered) node.append(rendered);
          else {
            const fallback = document.createElement('p');
            fallback.className = 'hint';
            fallback.textContent = record.title;
            node.append(fallback);
          }
          const item = { record, render, node, lifetime };
          records.set(record.id, item);
          return item;
        })
      : [];
    view.history(history.messages, nodes, history.terminations, run, partial, tools, reset);
  }
  extensions.subscribe(view.refreshActions, signal);
  extensions.subscribeToTools(view.refreshTools, signal);
  extensions.subscribeToRecords(render, signal);
  control.subscribe(['session', 'history', 'run', 'partial', 'tools'], render, signal);
  let operation = control.get().interaction.operation;
  control.subscribe(
    ['interaction'],
    () => {
      const next = control.get().interaction.operation;
      if (next !== operation && (next === 'submit' || next === 'queue')) view.follow();
      operation = next;
    },
    signal,
  );
  render();
  return viewport;
}
