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
import type { RunEvent } from '@mini-harness/runs/stream';
import type { RunInfo } from '@mini-harness/sessions/run-state';
import type { HistoryEntry } from '@mini-harness/sessions/message';
import { isRunning } from '@mini-harness/sessions/run-state';
import { payload } from '@mini-harness/ui-runtime/http';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import { readConversation, observeRun } from '../session-client.ts';

const path = (id: string, suffix = '') => '/sessions/' + id + suffix;

export function createConversationController(ctx: Context): ConversationController {
  const { miniSelection: selection, miniSessions: sessions } = ctx;
  const subscriptions = new Set<{ parts: readonly (keyof ConversationState)[]; listener: () => void }>();
  let state: ConversationState = {
    partial: '',
    tools: [],
    queue: [],
    interaction: { status: '' },
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
    if (state.interaction.status !== text || Boolean(state.interaction.error) !== error)
      interact({ status: text, error });
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
    update({
      session: 'id' in session ? session : undefined,
      run,
      history: undefined,
      partial: '',
      tools: [],
      queue: [],
    });
    selection.selectConversation(item, revealWorkspace);
  }

  function display(item: ConversationView, signal: AbortSignal, revealWorkspace: boolean) {
    const { run, timeline, leafId, partial = '', tools, queue, ...session } = item;
    queueRevision++;
    update({ session, run, history: { timeline, leafId }, partial, tools, queue });
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
        case 'user': {
          const {
            id,
            parentId,
            submissionId,
            inboxId,
            timestamp,
            content,
            attachments,
            model,
            thinkingLevel,
          } = event;
          append(
            {
              id,
              parentId,
              submissionId,
              inboxId,
              timestamp,
              content,
              attachments,
              type: 'message',
              role: 'user',
              runId: event.runId,
            },
            { session: state.session && { ...state.session, model, thinkingLevel } },
          );
          break;
        }
        case 'assistant-start':
          update({ partial: '' });
          break;
        case 'delta':
          update({ partial: state.partial + event.text });
          break;
        case 'assistant-end':
          append({ ...event.message, runId: event.runId }, { partial: '' });
          break;
        case 'tool': {
          const tools = state.tools.filter(({ id }) => id !== event.id);
          if (event.entry) {
            append(
              {
                id: event.entry.id,
                parentId: event.entry.parentId,
                type: 'message',
                role: 'toolResult',
                runId: event.runId,
                toolCallId: event.id,
                toolName: event.name,
                content: event.content ?? '',
                arguments: event.arguments,
                timestamp: event.entry.timestamp,
                sessionId: event.sessionId,
                elapsedMs: event.elapsedMs,
                approvalMs: event.approvalMs,
                exitCode: event.exitCode,
                toolState: event.state,
                isError: event.isError,
              },
              { tools },
            );
          } else {
            const index = state.tools.findIndex(({ id }) => id === event.id);
            const { runId: _runId, runSessionId: _sessionId, sequence: _sequence, ...tool } = event;
            tools.splice(index === -1 ? tools.length : index, 0, tool);
            update({ tools });
          }
          status(
            event.state === 'approval'
              ? 'Waiting for approval…'
              : event.state === 'running'
                ? 'Running ' + event.name + '…'
                : 'Thinking…',
          );
          break;
        }
        case 'branch':
          if (event.display) append(event.display);
          else update({ history: { timeline: state.history?.timeline ?? [], leafId: event.leafId } });
          break;
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
            update({ partial: '', tools: [] });
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
    if (isRunning(state.run) || state.interaction.operation)
      throw new Error('Wait for the current operation to finish.');
    const signal = begin();
    const workspace = selection.selectedWorkspace;
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
      }
      const { permission: _permission, revision, ...message } = input;
      const run = await browserRequest<RunInfo>(
        ctx,
        path(id, revision ? '/revise' : '/runs'),
        payload('POST', revision ? { ...message, ...revision } : message),
      );
      if (!signal.aborted) {
        update({ run });
        void activate(id);
      }
      return run;
    } finally {
      if (!signal.aborted) interact({ operation: undefined });
    }
  }

  async function queue(
    input: Omit<ConversationSubmission, 'revision' | 'permission'>,
    mode = browserPluginSettings(ctx).get<'steer' | 'followUp'>('queueMode'),
  ) {
    const id = active(),
      signal = visit.signal;
    if (!id || !isRunning(state.run) || state.interaction.operation)
      throw new Error('No running conversation to queue a message.');
    interact({ operation: 'queue' });
    try {
      const entries = await browserRequest<ConversationView['queue']>(
        ctx,
        path(id, '/queue'),
        payload('POST', { ...input, mode }),
      );
      if (!signal.aborted) {
        queueRevision++;
        update({ queue: entries });
      }
    } finally {
      if (!signal.aborted) interact({ operation: undefined });
    }
  }

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
    queue,
    retryInput() {
      const { session, run } = state;
      if (!session || run?.state !== 'failed') throw new Error('No failed run to retry.');
      return browserRequest<RetryInput | null>(ctx, path(session.id, '/runs/' + run.id + '/input'));
    },
    clear() {
      begin();
      select();
      update({ interaction: { status: '' } });
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
    async compact() {
      const id = active(),
        signal = visit.signal;
      if (!id) throw new Error('Open a conversation to compact it.');
      if (isRunning(state.run) || state.interaction.operation)
        throw new Error('Wait for the current operation to finish.');
      interact({ operation: 'compact', status: 'Compacting conversation…' });
      try {
        await browserRequest(ctx, path(id, '/compact'), payload('POST', {}));
        if (!signal.aborted && (await activate(id, false))) status('Conversation compacted.');
      } finally {
        if (!signal.aborted) interact({ operation: undefined });
      }
    },
  };
}
