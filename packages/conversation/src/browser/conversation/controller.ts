import type { Context } from 'cordis';
import type { FrontendApi } from '@mini-harness/ui-runtime/frontend-api';
import type { Conversation, ConversationView } from '../../shared/api.js';
import type { ConversationController, ConversationState, ConversationSubmission } from '../conversation-api.js';
import type { RunEvent } from '@mini-harness/runs/stream';
import type { RunInfo } from '@mini-harness/sessions/run-state';
import type { ViewMessage } from '@mini-harness/sessions/message';
import { isRunning } from '@mini-harness/sessions/run-state';
import { payload } from '@mini-harness/ui-runtime/http';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import { readConversation, observeRun } from '../session-client.js';

const emptyHistory = { messages: [], records: [], leafId: null };
const path = (id: string, suffix = '') => '/sessions/' + id + suffix;

export function createConversationController(ctx: Context, api: FrontendApi): ConversationController {
  const { miniSelection: selection, miniSessions: sessions } = ctx;
  const subscriptions = new Set<{ parts: readonly (keyof ConversationState)[]; listener: () => void }>();
  let state: ConversationState = { history: emptyHistory, partial: '', tools: [], queue: [], interaction: { status: '' } };
  let visit = new AbortController(), queueRevision = 0;
  const active = () => state.session?.id;
  function update(patch: Partial<ConversationState>) {
    const previous = state;
    state = { ...previous, ...patch };
    for (const { parts, listener } of subscriptions) {
      if (!parts.some((part) => state[part] !== previous[part])) continue;
      try { listener(); }
      catch (error) { console.error('Conversation subscriber failed', error); }
    }
  }
  const interact = (patch: Partial<ConversationState['interaction']>) => update({ interaction: { ...state.interaction, ...patch } });
  const status = (text: string, error = false) => {
    if (state.interaction.status !== text || Boolean(state.interaction.error) !== error) interact({ status: text, error });
  };
  const report = (error: Error) => status(error.message, true);
  function begin() {
    visit.abort();
    visit = new AbortController();
    return visit.signal;
  }
  function select(item?: Conversation, revealWorkspace = true) {
    const { run, ...session } = item ?? { run: undefined };
    queueRevision++;
    update({ session: 'id' in session ? session : undefined, run,
      history: emptyHistory, partial: '', tools: [], queue: [] });
    selection.selectConversation(item, revealWorkspace);
  }

  function display(item: ConversationView, signal: AbortSignal, revealWorkspace: boolean) {
    const { run, messages, records, leafId, partial = '', tools, queue, ...session } = item;
    queueRevision++;
    update({ session, run, history: { messages, records, leafId }, partial, tools, queue });
    selection.selectConversation(item, revealWorkspace);
    status(item.logError ?? '', Boolean(item.logError));
    if (!signal.aborted && isRunning(run)) void observe(item, signal);
  }

  function append(message: ViewMessage, patch: Partial<ConversationState> = {}) {
    const history = state.history;
    update({ ...patch, history: { ...history, leafId: message.id ?? history.leafId, messages: [...history.messages, message] } });
  }

  async function observe(item: ConversationView, signal: AbortSignal) {
    status(item.run?.state === 'queued' ? 'Queued…' : 'Thinking…');
    function accept(event: RunEvent) {
      if (signal.aborted) return;
      switch (event.type) {
        case 'user': {
          if (state.history.messages.some(({ id }) => id === event.id)) break;
          const { id, parentId, submissionId, timestamp, content, attachments, model, thinkingLevel } = event;
          append({ id, parentId, submissionId, timestamp, content, attachments, role: 'user' },
            { session: state.session && { ...state.session, model, thinkingLevel } });
          break;
        }
        case 'assistant-start': update({ partial: '' }); break;
        case 'delta': update({ partial: state.partial + event.text }); break;
        case 'assistant-end': append(event.message, { partial: '' }); break;
        case 'tool': {
          const tools = state.tools.filter(({ id }) => id !== event.id);
          if (event.entry) {
            append({ id: event.entry.id, parentId: event.entry.parentId, role: 'toolResult', toolCallId: event.id, toolName: event.name,
              content: event.content ?? '', arguments: event.arguments, timestamp: event.entry.timestamp,
              sessionId: event.sessionId, elapsedMs: event.elapsedMs, approvalMs: event.approvalMs, exitCode: event.exitCode,
              approvalDenied: event.state === 'denied', isError: event.state === 'error' }, { tools });
          } else {
            const index = state.tools.findIndex(({ id }) => id === event.id);
            const { runId: _runId, runSessionId: _sessionId, sequence: _sequence, ...tool } = event;
            tools.splice(index === -1 ? tools.length : index, 0, tool);
            update({ tools });
          }
          status(event.state === 'approval' ? 'Waiting for approval…' : event.state === 'running' ? 'Running ' + event.name + '…' : 'Thinking…');
          break;
        }
        case 'snapshot':
          update({ run: event.run, history: { ...state.history, messages: event.messages, records: event.records, leafId: event.leafId },
            partial: event.partial ?? '', tools: event.tools ?? [],
            session: state.session && { ...state.session, model: event.model, thinkingLevel: event.thinkingLevel } });
          if (!isRunning(event.run)) interact({ cancelling: false, status: '' });
          break;
        case 'run':
          update({ run: event.run, ...(!isRunning(event.run) ? { partial: '', tools: [] } : {}) });
          if (!isRunning(event.run)) interact({ cancelling: false, status: '' });
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
    const selected = sessions.get().find((entry) => entry.id === id);
    if (id !== active()) select(selected, revealWorkspace);
    interact({ operation: 'open', status: 'Loading conversation…', error: false, cancelling: false });
    try {
      const item = await readConversation(id, signal);
      if (signal.aborted) return false;
      display(item, signal, revealWorkspace);
      return true;
    } catch (error) { if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error))); return false; }
    finally { if (!signal.aborted) interact({ operation: undefined }); }
  }

  async function submit(input: ConversationSubmission, created?: (sessionId: string) => void) {
    if (isRunning(state.run) || state.interaction.operation) throw new Error('Wait for the current operation to finish.');
    const signal = begin();
    const workspace = selection.selectedWorkspace;
    interact({ operation: 'submit', status: '' });
    let id = active();
    try {
      if (!id) {
        if (!workspace) throw new Error('Add a workspace before starting a conversation.');
        const item = await api.request<Conversation>(workspaceRoute(workspace, '/sessions'), payload('POST', { permission: input.permission ?? 'standard' }));
        id = item.id;
        created?.(id);
        await sessions.refresh();
        if (!signal.aborted) select(item);
      }
      const { permission: _permission, revision, ...message } = input;
      const run = await api.request<RunInfo & { accepted: boolean }>(path(id, revision ? '/revise' : '/runs'),
        payload('POST', revision ? { ...message, ...revision } : message));
      if (!signal.aborted) void activate(id);
      return run;
    } finally { if (!signal.aborted) interact({ operation: undefined }); }
  }

  async function queue(input: Omit<ConversationSubmission, 'revision' | 'permission'>, mode = api.configuration.get<'steer' | 'followUp'>('queueMode')) {
    const id = active(), signal = visit.signal;
    if (!id || !isRunning(state.run) || state.interaction.operation) throw new Error('No running conversation to queue a message.');
    interact({ operation: 'queue' });
    try {
      const entries = await api.request<ConversationView['queue']>(path(id, '/queue'), payload('POST', { ...input, mode }));
      if (!signal.aborted) { queueRevision++; update({ queue: entries }); }
    } finally { if (!signal.aborted) interact({ operation: undefined }); }
  }

  api.onDispose(ctx.miniProjections.register('conversation-records', {
    async sync(_revision, reconnect, changedId) {
      const id = active(), signal = visit.signal;
      if (!id || (!reconnect && changedId && id !== changedId)) return;
      try {
        const records = await api.request<ConversationView['records']>(path(id, '/records'), { signal });
        if (!signal.aborted) update({ history: { ...state.history, records } });
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
    subscribe(parts, listener, signal) {
      if (signal.aborted) return;
      const entry = { parts, listener };
      subscriptions.add(entry);
      signal.addEventListener('abort', () => { subscriptions.delete(entry); }, { once: true });
    },
    activate, report, submit, queue,
    clear() { begin(); select(); update({ interaction: { status: '' } }); },
    async cancel() {
      const id = active(), signal = visit.signal;
      if (!id || !isRunning(state.run)) return;
      interact({ cancelling: true, status: 'Cancelling…' });
      try { await api.request(path(id, '/cancel'), payload('POST', {})); }
      catch (error) { if (!signal.aborted) { interact({ cancelling: false }); throw error; } }
    },
    async cancelQueue(item) {
      const id = active(), signal = visit.signal;
      if (!id) return;
      const revision = ++queueRevision;
      const entries = await api.request<ConversationView['queue']>(path(id, '/queue' + (item ? '/' + encodeURIComponent(item) : '')), { method: 'DELETE' });
      if (!signal.aborted && revision === queueRevision) update({ queue: entries });
    },
    async setPermission(permission) {
      const id = active(), signal = visit.signal;
      if (!id) throw new Error('Open a conversation first.');
      const item = await api.request<Conversation>(path(id, '/permissions'), payload('PATCH', { permission }));
      if (!signal.aborted && state.session) update({ session: { ...state.session, permission: item.permission } });
      await sessions.refresh();
    },
    async compact() {
      const id = active(), signal = visit.signal;
      if (!id) throw new Error('Open a conversation to compact it.');
      if (isRunning(state.run) || state.interaction.operation) throw new Error('Wait for the current operation to finish.');
      interact({ operation: 'compact', status: 'Compacting conversation…' });
      try {
        await api.request(path(id, '/compact'), payload('POST', {}));
        if (!signal.aborted && await activate(id, false)) status('Conversation compacted.');
      } finally { if (!signal.aborted) interact({ operation: undefined }); }
    }
  };
}
