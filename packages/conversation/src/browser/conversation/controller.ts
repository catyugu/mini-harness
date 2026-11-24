import type { Context } from 'cordis';
import type { FrontendApi } from '@mini-harness/ui-runtime/frontend-api';
import type { Conversation, ConversationView } from '../../shared/api.js';
import type { ConversationController, ConversationState, ConversationSubmission } from '../composer-api.js';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { RunEvent } from '@mini-harness/runs/stream';
import type { RunInfo } from '@mini-harness/sessions/run-state';
import type { MessageContent } from '@mini-harness/sessions/message';
import { isRunning } from '@mini-harness/sessions/run-state';
import { payload } from '@mini-harness/ui-runtime/http';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import { readConversation, observeRun } from '../session-client.js';

export function messageText(value?: MessageContent) {
  return typeof value === 'string' ? value : value?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') ?? '';
}

/** The selected conversation and its live run belong to the controller, not to a renderer. */
export function createConversationController(ctx: Context, api: FrontendApi): ConversationController {
  const { miniSelection: selection, miniSessions: sessions } = ctx;
  const changes = new EventTarget();
  let state: ConversationState = { events: [], records: [], recordMessages: [], queue: [], pending: false, sending: false, cancelling: false, status: '', error: false };
  let visit = new AbortController(), queueRevision = 0;
  const lastInputs = new Map<string, ConversationSubmission>();
  const active = () => state.conversation?.id;
  const update = (patch: Partial<ConversationState>) => {
    state = { ...state, ...patch };
    changes.dispatchEvent(new Event('change'));
  };
  const status = (text: string, error = false) => update({ status: text, error });
  const report = (error: Error) => status(error.message, true);
  const begin = () => {
    visit.abort();
    visit = new AbortController();
    return visit.signal;
  };
  const path = (id: string, suffix = '') => '/sessions/' + id + suffix;
  const read = readConversation;

  function remember(id: string, content: MessageContent) {
    if (lastInputs.has(id)) return;
    const attachments = (typeof content === 'string' ? [] : content ?? []).flatMap((block) =>
      block.type === 'image' && block.mimeType && block.data ? [{ name: 'image', mimeType: block.mimeType, data: block.data }] : []);
    lastInputs.set(id, { message: messageText(content), attachments });
  }

  function select(item?: Conversation, view?: ConversationView, revealWorkspace = true) {
    const previous = view?.messages.filter((message) => message.role === 'user').at(-1);
    if (item && previous) remember(item.id, previous.content);
    queueRevision++;
    update({ conversation: item, view, run: item?.run, sending: isRunning(item?.run), cancelling: false,
      events: [], records: view?.records ?? [], recordMessages: view?.messages ?? [], queue: view?.queue ?? [] });
    selection.selectConversation(item, revealWorkspace);
  }

  function display(item: ConversationView, signal: AbortSignal, revealWorkspace: boolean) {
    select(item, item, revealWorkspace);
    if (signal.aborted) return;
    status(item.logError ?? '', Boolean(item.logError));
    if (isRunning(item.run)) void observe(item, signal);
  }

  async function observe(item: ConversationView, signal: AbortSignal) {
    status(item.run?.state === 'queued' ? 'Queued…' : 'Thinking…');
    function accept(event: RunEvent) {
      if (signal.aborted) return;
      if (event.type === 'snapshot') {
        update({ view: { ...item, messages: event.messages, partial: event.partial, tools: event.tools ?? [], run: event.run },
          events: [], recordMessages: event.messages });
      } else update({ events: [...state.events, event] });
      switch (event.type) {
        case 'user': remember(item.id, event.content); break;
        case 'tool': status(event.state === 'approval' ? 'Waiting for approval…' : event.state === 'running' ? 'Running ' + event.name + '…' : 'Thinking…'); break;
        case 'complete':
        case 'error': status(''); break;
        case 'run':
        case 'snapshot':
          update({ run: event.run, sending: isRunning(event.run), cancelling: isRunning(event.run) && state.cancelling });
          if (!isRunning(event.run)) { queueRevision++; update({ queue: [] }); status(''); }
          break;
      }
    }
    try {
      const latest = await observeRun(item, signal, accept, () => status('Reconnecting…'));
      if (latest && !signal.aborted) display(latest, signal, false);
    } catch (error) { if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error))); }
  }

  async function activate(id: string, revealWorkspace = true) {
    const signal = begin();
    update({ pending: true });
    const selected = sessions.get().find((entry) => entry.id === id);
    if (selected && id !== active()) { select(selected, undefined, revealWorkspace); status('Loading conversation…'); }
    try {
      const item = await read(id, signal);
      if (!signal.aborted) { display(item, signal, revealWorkspace); ctx.miniLayout.closeDrawer(); }
    } catch (error) { if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error))); }
    finally { if (!signal.aborted) update({ pending: false }); }
  }

  async function submit(input: ConversationSubmission) {
    if (state.sending || state.pending) throw new Error('Wait for the current operation to finish.');
    const signal = begin();
    const workspace = selection.selectedWorkspace;
    update({ pending: true, sending: true });
    try {
      let id = active();
      if (!id) {
        if (!workspace) throw new Error('Add a workspace before starting a conversation.');
        const item = await api.request<Conversation>(workspaceRoute(workspace, '/sessions'), payload('POST', { permission: input.permission ?? 'standard' }));
        id = item.id;
        await sessions.refresh();
      }
      const { permission: _permission, revision, ...message } = input;
      const run = await api.request<RunInfo>(path(id, revision ? '/revise' : '/runs'), payload('POST', revision ? { ...message, ...revision } : message));
      lastInputs.set(id, message);
      if (!signal.aborted) { update({ pending: false }); void activate(id); }
      return { sessionId: id, run };
    } catch (error) {
      if (!signal.aborted) update({ pending: false, sending: false });
      throw error;
    }
  }

  async function queue(input: Omit<ConversationSubmission, 'revision' | 'permission'>, mode = api.configuration.get<'steer' | 'followUp'>('queueMode')) {
    const id = active(), signal = visit.signal;
    if (!id || !state.sending || state.pending) throw new Error('No running conversation to queue a message.');
    update({ pending: true });
    try {
      const entries = await api.request<ConversationView['queue']>(path(id, '/queue'), payload('POST', { ...input, mode }));
      if (!signal.aborted) { queueRevision++; update({ queue: entries }); }
    } finally { if (!signal.aborted) update({ pending: false }); }
  }

  api.onDispose(ctx.miniProjections.register('conversation-records', {
    async sync(_revision, reconnect, changedId) {
      const id = active(), signal = visit.signal;
      if (!id || (!reconnect && changedId && id !== changedId)) return;
      try {
        const item = await read(id, signal);
        if (!signal.aborted) update({ records: item.records, recordMessages: item.messages });
      } catch (error) { if (!signal.aborted) throw error; }
    }
  }));
  api.onDispose(ctx.miniProjections.register('queue', {
    async sync(_revision, reconnect, changedId) {
      const id = active(), signal = visit.signal;
      if (!id || (!reconnect && changedId && id !== changedId)) return;
      const revision = ++queueRevision;
      try {
        const entries = await api.request<ConversationView['queue']>(path(id, '/queue'), { signal });
        if (!signal.aborted && revision === queueRevision) update({ queue: entries });
      } catch (error) { if (!signal.aborted && revision === queueRevision) throw error; }
    }
  }));
  api.onDispose(() => visit.abort());

  return {
    get: () => state,
    subscribe: (listener, signal) => changes.addEventListener('change', listener, { signal }),
    activate, report, submit, queue,
    clear() { begin(); update({ pending: false }); select(); status(''); },
    async cancel() {
      const id = active(), signal = visit.signal;
      if (!id || !state.sending) return;
      update({ cancelling: true }); status('Cancelling…');
      try { await api.request(path(id, '/cancel'), payload('POST', {})); }
      catch (error) { if (!signal.aborted) { update({ cancelling: false }); throw error; } }
    },
    async cancelQueue(item) {
      const id = active(), signal = visit.signal;
      if (!id) return;
      const revision = ++queueRevision;
      const entries = await api.request<ConversationView['queue']>(path(id, '/queue' + (item ? '/' + encodeURIComponent(item) : '')), { method: 'DELETE' });
      if (!signal.aborted && revision === queueRevision) update({ queue: entries });
    },
    async setPermission(permission: ConversationPermission) {
      const id = active();
      if (!id) throw new Error('Open a conversation first.');
      const item = await api.request<Conversation>(path(id, '/permissions'), payload('PATCH', { permission }));
      if (active() === id) update({ conversation: item });
      await sessions.refresh();
    },
    async retry() {
      const id = active(), input = id ? lastInputs.get(id) : undefined;
      if (input && !state.sending && !state.pending) await submit(input);
    },
    async compact() {
      const id = active(), signal = visit.signal;
      if (!id) throw new Error('Open a conversation to compact it.');
      if (state.sending || state.pending) throw new Error('Wait for the current operation to finish.');
      update({ pending: true }); status('Compacting conversation…');
      try {
        await api.request(path(id, '/compact'), payload('POST', {}));
        if (!signal.aborted) {
          const item = await read(id, signal);
          if (!signal.aborted) { display(item, signal, false); status('Conversation compacted.'); }
        }
      } finally { if (!signal.aborted) update({ pending: false }); }
    }
  };
}
