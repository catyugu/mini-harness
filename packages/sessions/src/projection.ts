import { userContent } from './user-content.ts';
import type { SessionDisplayRecord } from './shared/display-record.ts';
import { isRunning } from './shared/run-state.ts';
import { toolResultState } from '@mini-harness/tools/api';
import type { NativeMessage, NativeToolMessage } from '@mini-harness/llm/api';
import type { MessageContent, ViewMessage } from './shared/message.ts';
import type { SessionEntry, SessionProjection } from './log-api.ts';
import { applyContentDelta } from './content-delta.ts';

export function projectMessage(
  entry: SessionEntry,
  execution: (id: string) => NativeToolMessage | undefined,
): NativeMessage | undefined {
  if (entry.type === 'message') return entry.message;
  if (entry.type !== 'tool-accepted') return;
  const result = execution(entry.executionId);
  if (!result) throw new Error('Missing completed tool execution');
  const content = entry.contentDelta
    ? (JSON.parse(
        applyContentDelta(JSON.stringify(result.content), entry.contentDelta),
      ) as typeof result.content)
    : result.content;
  return { ...result, content };
}

export function displayMessage<M extends NativeMessage>(
  entry: SessionEntry,
  message: M,
  runId?: string,
  toolArguments?: unknown,
): Extract<ViewMessage, { role: M['role'] }>;
export function displayMessage(
  entry: SessionEntry,
  message: NativeMessage,
  runId?: string,
  toolArguments?: unknown,
): ViewMessage {
  const fields = {
    type: 'message' as const,
    id: entry.id,
    parentId: entry.parentId,
    runId,
    content: message.content as MessageContent,
    timestamp: message.timestamp,
  };
  const view: ViewMessage =
    message.role === 'toolResult'
      ? {
          ...fields,
          role: message.role,
          toolName: message.toolName,
          toolCallId: message.toolCallId,
          toolState: toolResultState(message),
        }
      : message.role === 'user'
        ? { ...fields, role: 'user' }
        : { ...fields, role: 'assistant' };
  if (entry.type === 'message') {
    if (entry.submissionId) view.submissionId = entry.submissionId;
    if (entry.inboxId) view.inboxId = entry.inboxId;
  }
  if (entry.type === 'message' && message.role === 'user')
    Object.assign(view, userContent(message.content, entry.presentation));
  if (message.role === 'assistant' && !runId && message.stopReason !== 'aborted')
    view.error = message.errorMessage;
  if (message.role === 'toolResult') {
    view.isError = message.isError;
    if (typeof message.details?.approvalMs === 'number') view.approvalMs = message.details.approvalMs;
    view.arguments = toolArguments;
    view.elapsedMs = (entry.type === 'message' ? entry.elapsedMs : undefined) ?? message.elapsedMs;
    if (typeof message.details?.sessionId === 'string') view.sessionId = message.details.sessionId;
    if (typeof message.details?.exitCode === 'number' && Number.isInteger(message.details.exitCode))
      view.exitCode = message.details.exitCode;
  }
  return view;
}

export function displayRecord(
  entry: Extract<SessionEntry, { type: 'plugin-record' }>,
): SessionDisplayRecord | undefined {
  if (entry.display)
    return {
      type: 'record',
      id: entry.id,
      plugin: entry.owner.pluginId,
      instanceId: entry.owner.instanceId,
      title: entry.display.title,
      content: entry.display.content,
    };
}

/** Read projections are pure and never write synthetic history back into the transcript. */
export function projectLog(
  branch: SessionEntry[],
  execution: (id: string) => NativeToolMessage | undefined,
  runs: readonly Extract<SessionEntry, { type: 'run' }>[],
): SessionProjection {
  const state: SessionProjection = {
    leafId: branch.at(-1)?.id ?? null,
    timeline: [],
    contextMessages: [],
    contextEntryIds: [],
  };
  const lastRun = runs.at(-1)?.run;
  if (lastRun) state.run = lastRun;
  const messageOf = (entry: SessionEntry) => projectMessage(entry, execution);
  const calls = new Map<string, unknown>();
  const edits = new Map<string, NativeMessage['content'] | null>();
  let compaction: Extract<SessionEntry, { type: 'compaction' }> | undefined;
  const ancestry = new Set(branch.map(({ id }) => id));
  let runIndex = 0;
  let runId: string | undefined;
  function projectRuns(before: number) {
    for (; runs[runIndex] && runs[runIndex].seq < before; runIndex++) {
      const { parentId, run } = runs[runIndex];
      // A revision can start on one branch and commit its new input on another.
      // Sequence bounds identify the producing run. Only its end is anchored to the branch.
      runId = isRunning(run) ? run.id : undefined;
      if (parentId !== null && !ancestry.has(parentId)) continue;
      const { id, state: outcome, error, startedAt, finishedAt } = run;
      if (outcome === 'failed' || outcome === 'cancelled' || outcome === 'interrupted')
        state.timeline.push({
          type: 'termination',
          id,
          state: outcome,
          startedAt,
          finishedAt,
          error,
        });
    }
  }
  for (const entry of branch) {
    projectRuns(entry.seq);
    if (entry.type === 'model') state.model = entry.model;
    if (entry.type === 'thinking') state.thinkingLevel = entry.level ?? undefined;
    if (entry.type === 'message' && entry.selection) {
      state.model = entry.selection.model;
      state.thinkingLevel = entry.selection.thinkingLevel;
    }
    if (entry.type === 'compaction') compaction = entry;
    if (entry.type === 'context-edit') edits.set(entry.targetId, entry.replacement);
    if (entry.type === 'plugin-record') {
      const record = displayRecord(entry);
      if (record) state.timeline.push(record);
    }
    const message = messageOf(entry);
    if (!message) continue;
    if (message.role === 'assistant')
      for (const block of message.content)
        if (block.type === 'toolCall') calls.set(block.id, block.arguments);
    state.timeline.push(
      displayMessage(
        entry,
        message,
        runId,
        message.role === 'toolResult' ? calls.get(message.toolCallId) : undefined,
      ),
    );
  }
  projectRuns(Infinity);
  let context = branch;
  if (compaction) {
    const from = compaction.keepFromId && branch.findIndex(({ id }) => id === compaction.keepFromId);
    context =
      typeof from === 'number' && from >= 0
        ? branch.slice(from)
        : branch.slice(branch.indexOf(compaction) + 1);
    state.contextMessages.push({
      role: 'user',
      content: 'Summary of earlier conversation:\n' + compaction.summary,
      timestamp: Date.parse(compaction.timestamp),
    });
    state.contextEntryIds.push(compaction.id);
  }
  state.contextMessages.push(
    ...context.flatMap<NativeMessage>((entry) => {
      const message = messageOf(entry);
      if (!message || edits.get(entry.id) === null) return [];
      state.contextEntryIds.push(entry.id);
      return [
        { ...message, ...(edits.has(entry.id) ? { content: edits.get(entry.id) } : {}) } as NativeMessage,
      ];
    }),
  );
  return state;
}
