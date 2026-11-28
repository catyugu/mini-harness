import { browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import type { Conversation, ConversationView } from '../../shared/api.ts';
import type {
  ConversationController,
  ConversationState,
  ConversationSubmission,
  RetryInput,
} from '../conversation-api.ts';
import { updateRecords, updateTools, type RunEvent } from '@mini-harness/runs/stream';
import type { SendReceipt } from '@mini-harness/runs/api';
import { defaultMessageMode, type MessageMode } from '@mini-harness/sessions/queue';
import type { RunInfo } from '@mini-harness/sessions/run-state';
import type { HistoryEntry } from '@mini-harness/sessions/message';
import { isRunning } from '@mini-harness/sessions/run-state';
import { payload } from '@mini-harness/ui-runtime/http';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import { readConversation, observeRun } from '../session-client.ts';

const path = (id: string, suffix = '') => '/sessions/' + id + suffix;

export function createConversationController(ctx: Context): ConversationController {
  const { miniSelection: selection, miniSessions: sessions } = ctx;
  const settings = browserPluginSettings(ctx);
  const modes = new Map<string, MessageMode>();
  const modeFor = (session?: string) =>
    (session && modes.get(session)) || settings.get<MessageMode>('messageMode') || defaultMessageMode;
  const subscriptions = new Set<{ parts: readonly (keyof ConversationState)[]; listener: () => void }>();
  let state: ConversationState = {
    partial: '',
    tools: [],
    records: [],
    queue: [],
    mode: modeFor(),
    interaction: { status: '', cancelling: false, error: false },
  };
  let visit = new AbortController(),
    queueRevision = 0,
    branchRevision = 0;
  const active = () => state.session?.id;
  function update(patch: Partial<ConversationState>) {
    const previous = state;
    state = { ...previous, ...patch };
    for (const { parts, listener } of subscriptions) {
      if (!parts.some((part) => state[part] !== previous[part])) continue;
      try {
        listener();
      } catch (error) {
        console.error('Conversation subscriber failed', error);
      }
    }
  }
  const interact = (patch: Partial<ConversationState['interaction']>) =>
    update({ interaction: { ...state.interaction, ...patch } });
  const status = (text: string, error = false) => {
    if (state.interaction.status !== text || state.interaction.error !== error)
      interact({ status: text, error });
  };
  const report = (message: string | Error) =>
    typeof message === 'string' ? status(message) : status(message.message, true);
  function begin() {
    visit.abort();
    visit = new AbortController();
    return visit.signal;
  }
  function select(item?: Conversation, revealWorkspace = true) {
    const { run, ...session } = item ?? { run: undefined };
    queueRevision++;
    update({
      session: 'id' in session ? session : undefined,
      run,
      mode: modeFor(item?.id),
      history: undefined,
      partial: '',
      tools: [],
      records: [],
      queue: [],
    });
    selection.selectConversation(item, revealWorkspace);
  }

  function display(item: ConversationView, signal: AbortSignal, revealWorkspace: boolean) {
    const { run, timeline, leafId, partial = '', tools, records, queue, ...session } = item;
    queueRevision++;
    update({ session, run, history: { timeline, leafId }, partial, tools, records, queue });
    selection.selectConversation(item, revealWorkspace);
    status(item.logError ?? '', Boolean(item.logError));
    if (!signal.aborted && isRunning(run)) void observe(item, signal);
  }

  function append(entry: HistoryEntry, patch: Partial<ConversationState> = {}) {
    const timeline = state.history?.timeline ?? [];
    if (timeline.some(({ id }) => id === entry.id)) {
      update(patch);
      return;
    }
    update({ ...patch, history: { leafId: entry.id, timeline: [...timeline, entry] } });
  }

  async function refreshBranch() {
    const id = active(),
      signal = visit.signal,
      revision = branchRevision;
    if (!id || isRunning(state.run) || state.interaction.operation) return;
    try {
      const item = await readConversation(id, signal);
      if (
        !signal.aborted &&
        revision === branchRevision &&
        !isRunning(state.run) &&
        !state.interaction.operation
      )
        display(item, signal, false);
    } catch (error) {
      if (!signal.aborted && revision === branchRevision) throw error;
    }
  }

  async function observe(item: ConversationView, signal: AbortSignal) {
    let terminal: RunInfo | undefined,
      revision = branchRevision;
    status(item.run?.state === 'queued' ? 'Queued…' : 'Thinking…');
    function accept(event: RunEvent) {
      if (signal.aborted) return;
      switch (event.type) {
        case 'user':
          append(event.message, {
            session: state.session && {
              ...state.session,
              model: event.model,
              thinkingLevel: event.thinkingLevel,
            },
          });
          break;
        case 'assistant-start':
          update({ partial: '' });
          break;
        case 'delta':
          update({ partial: state.partial + event.text });
          break;
        case 'assistant-end':
          append(event.message, { partial: '' });
          break;
        case 'tool-end':
          append(event.message, { tools: updateTools(state.tools, event) });
          status('Thinking…');
          break;
        case 'tool': {
          const { runId: _runId, runSessionId: _sessionId, sequence: _sequence, ...tool } = event;
          update({ tools: updateTools(state.tools, tool) });
          status(tool.state === 'approval' ? 'Waiting for approval…' : 'Running ' + tool.name + '…');
          break;
        }
        case 'tool-output':
          update({ tools: updateTools(state.tools, event) });
          break;
        case 'record-update':
          update({ records: updateRecords(state.records, event) });
          break;
        case 'branch': {
          const timeline = [...(state.history?.timeline ?? [])];
          for (const record of event.records) {
            const index = timeline.findIndex(({ id }) => id === record.id);
            timeline.splice(index < 0 ? timeline.length : index, index < 0 ? 0 : 1, record);
          }
          const ids = new Set(event.records.map(({ id }) => id));
          update({
            history: { timeline, leafId: event.leafId },
            records: state.records.filter(({ id }) => !ids.has(id)),
          });
          break;
        }
        case 'snapshot':
          if (!isRunning(event.run)) {
            terminal = event.run;
            revision = branchRevision;
          }
          update({
            run: terminal ? state.run : event.run,
            history: { timeline: event.timeline, leafId: event.leafId },
            partial: event.partial ?? '',
            tools: event.tools ?? [],
            records: event.records,
            session: state.session && {
              ...state.session,
              model: event.model,
              thinkingLevel: event.thinkingLevel,
            },
          });
          if (!isRunning(event.run)) interact({ cancelling: false, status: '' });
          break;
        case 'run':
          if (isRunning(event.run)) update({ run: event.run });
          else {
            // Keep observation active until the final authoritative conversation snapshot arrives.
            terminal = event.run;
            revision = branchRevision;
            update({ partial: '', tools: [], records: [] });
            interact({ cancelling: false, status: '' });
          }
          break;
      }
    }
    try {
      const latest = await observeRun(item, signal, accept, () => status('Reconnecting…'));
      if (latest && !signal.aborted) {
        display(latest, signal, false);
        if (!isRunning(latest.run) && revision !== branchRevision) await refreshBranch();
      }
    } catch (error) {
      if (!signal.aborted) {
        if (terminal) update({ run: terminal });
        report(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async function activate(id: string, revealWorkspace = true) {
    const signal = begin();
    const selected = sessions.get().find((entry) => entry.id === id);
    interact({ operation: 'open', status: 'Loading conversation…', error: false, cancelling: false });
    if (id !== active()) select(selected, revealWorkspace);
    const revision = branchRevision;
    try {
      const item = await readConversation(id, signal);
      if (signal.aborted) return false;
      display(item, signal, revealWorkspace);
      interact({ operation: undefined });
      if (!isRunning(item.run) && revision !== branchRevision) await refreshBranch();
      return !signal.aborted;
    } catch (error) {
      if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error)));
      return false;
    } finally {
      if (!signal.aborted && state.interaction.operation === 'open') interact({ operation: undefined });
    }
  }

  async function submit(input: ConversationSubmission, created?: (sessionId: string) => void) {
    if ((input.revision && isRunning(state.run)) || state.interaction.operation)
      throw new Error('Wait for the current operation to finish.');
    const signal = visit.signal;
    const workspace = selection.selectedWorkspace;
    const mode = isRunning(state.run) ? state.mode : undefined;
    interact({ operation: 'submit', status: '' });
    let id = active();
    try {
      if (!id) {
        if (!workspace) throw new Error('Add a workspace before starting a conversation.');
        const item = await browserRequest<Conversation>(
          ctx,
          workspaceRoute(workspace, '/sessions'),
          payload('POST', { permission: input.permission ?? 'standard' }),
        );
        id = item.id;
        created?.(id);
        await sessions.refresh();
        if (!signal.aborted) select(item);
        await ctx.parallel('conversation/initialize', workspace, id);
      }
      const { permission: _permission, revision, ...message } = input;
      if (revision) {
        const run = await browserRequest<RunInfo>(
          ctx,
          path(id, '/revise'),
          payload('POST', { ...message, ...revision }),
        );
        if (!signal.aborted) void activate(id);
        return run;
      }
      const receipt = await browserRequest<SendReceipt>(
        ctx,
        path(id, '/runs'),
        payload('POST', { ...message, mode }),
      );
      if (!signal.aborted) {
        queueRevision++;
        update({ queue: receipt.queue });
        if (!isRunning(state.run)) void activate(id);
      }
    } finally {
      if (!signal.aborted) interact({ operation: undefined });
    }
  }

  settings.subscribe('messageMode', () => update({ mode: modeFor(active()) }));
  sessions.subscribe(() => {
    const latest = sessions.get().find(({ id }) => id === active());
    if (
      latest?.run &&
      latest.run.id !== state.run?.id &&
      !isRunning(state.run) &&
      !state.interaction.operation
    )
      void refreshBranch().catch(report);
  }, ctx.fiber.signal);

  ctx.effect(() =>
    ctx.miniProjections.register('conversation-records', {
      async sync(_revision, reconnect, changedId) {
        const id = active();
        if (!id || (!reconnect && changedId && id !== changedId)) return;
        branchRevision++;
        await refreshBranch();
      },
    }),
  );
  ctx.effect(() =>
    ctx.miniProjections.register('queue', {
      async sync(_revision, reconnect, changedId) {
        const id = active(),
          signal = visit.signal;
        if (!id || (!reconnect && changedId && id !== changedId)) return;
        const revision = ++queueRevision;
        try {
          const entries = await browserRequest<ConversationView['queue']>(ctx, path(id, '/queue'), {
            signal,
          });
          if (!signal.aborted && revision === queueRevision) update({ queue: entries });
        } catch (error) {
          if (!signal.aborted && revision === queueRevision) throw error;
        }
      },
    }),
  );
  ctx.effect(() => () => visit.abort());

  return {
    get: () => state,
    subscribe(parts, listener, signal) {
      if (signal.aborted) return;
      const entry = { parts, listener };
      subscriptions.add(entry);
      signal.addEventListener(
        'abort',
        () => {
          subscriptions.delete(entry);
        },
        { once: true },
      );
    },
    activate,
    report,
    submit,
    chooseMode(mode) {
      const id = active();
      if (id) modes.set(id, mode);
      update({ mode });
    },
    retryInput() {
      const { session, run } = state;
      if (!session || run?.state !== 'failed') throw new Error('No failed run to retry.');
      return browserRequest<RetryInput | null>(ctx, path(session.id, '/runs/' + run.id + '/input'));
    },
    clear() {
      begin();
      select();
      update({ interaction: { status: '', cancelling: false, error: false } });
    },
    async cancel() {
      const id = active(),
        signal = visit.signal;
      if (!id || !isRunning(state.run)) return;
      interact({ cancelling: true, status: 'Cancelling…' });
      try {
        await browserRequest(ctx, path(id, '/cancel'), payload('POST', {}));
      } catch (error) {
        if (!signal.aborted) {
          interact({ cancelling: false });
          throw error;
        }
      }
    },
    async cancelQueue(item) {
      const id = active(),
        signal = visit.signal;
      if (!id) return;
      const revision = ++queueRevision;
      const entries = await browserRequest<ConversationView['queue']>(
        ctx,
        path(id, '/queue' + (item ? '/' + encodeURIComponent(item) : '')),
        { method: 'DELETE' },
      );
      if (!signal.aborted && revision === queueRevision) update({ queue: entries });
    },
    async setPermission(permission) {
      const id = active(),
        signal = visit.signal;
      if (!id) throw new Error('Open a conversation first.');
      const item = await browserRequest<Conversation>(
        ctx,
        path(id, '/permissions'),
        payload('PATCH', { permission }),
      );
      if (!signal.aborted && state.session)
        update({ session: { ...state.session, permission: item.permission } });
      await sessions.refresh();
    },
  };
}
