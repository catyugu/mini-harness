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

/** Read projections are pure and never write synthetic history back into the transcript. */
export function projectLog(
  branch: SessionEntry[],
  execution: (id: string) => NativeToolMessage | undefined,
  runs: readonly Extract<SessionEntry, { type: 'run' }>[],
): SessionProjection {
  const state: SessionProjection = {
    leafId: branch.at(-1)?.id ?? null,
    messages: [],
    records: [],
    terminations: [],
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
  let afterEntryId: string | null = null;
  function projectRuns(before: number) {
    for (; runs[runIndex] && runs[runIndex].seq < before; runIndex++) {
      const { parentId, run } = runs[runIndex];
      runId = isRunning(run) ? run.id : undefined;
      if (parentId !== null && !ancestry.has(parentId)) continue;
      const { id, state: outcome, error, startedAt, finishedAt } = run;
      if (outcome === 'failed' || outcome === 'cancelled' || outcome === 'interrupted')
        state.terminations.push({
          id,
          state: outcome,
          afterEntryId,
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
    if (entry.type === 'plugin-record' && entry.display) {
      afterEntryId = entry.id;
      state.records.push({
        id: entry.id,
        plugin: entry.owner.pluginId,
        instanceId: entry.owner.instanceId,
        afterMessageId: state.messages.at(-1)?.id ?? null,
        title: entry.display.title,
        content: entry.display.content,
      });
    }
    const message = messageOf(entry);
    if (!message) continue;
    if (message.role === 'assistant')
      for (const block of message.content)
        if (block.type === 'toolCall') calls.set(block.id, block.arguments);
    const view: ViewMessage = {
      id: entry.id,
      parentId: entry.parentId,
      runId,
      role: message.role,
      content: message.content as MessageContent,
      timestamp: message.timestamp,
    };
    if (entry.type === 'message') {
      if (entry.submissionId) view.submissionId = entry.submissionId;
      if (entry.inboxId) view.inboxId = entry.inboxId;
    }
    if (entry.type === 'message' && message.role === 'user' && entry.presentation) {
      view.attachments = entry.presentation.attachments;
      const { userText, images } = entry.presentation;
      view.content =
        typeof message.content === 'string' && !images?.length
          ? userText
          : [
              ...(userText ? [{ type: 'text', text: userText }] : []),
              ...(images ??
                (typeof message.content === 'string'
                  ? []
                  : message.content.filter((block) => block.type === 'image'))),
            ];
    }
    if (message.role === 'assistant' && message.stopReason !== 'aborted') view.error = message.errorMessage;
    if (message.role === 'toolResult') {
      view.toolName = message.toolName;
      view.toolCallId = message.toolCallId;
      view.isError = message.isError;
      view.toolState = toolResultState(message);
      if (typeof message.details?.approvalMs === 'number') view.approvalMs = message.details.approvalMs;
      view.arguments = calls.get(message.toolCallId);
      view.elapsedMs = (entry.type === 'message' ? entry.elapsedMs : undefined) ?? message.elapsedMs;
      if (typeof message.details?.sessionId === 'string') view.sessionId = message.details.sessionId;
      if (typeof message.details?.exitCode === 'number' && Number.isInteger(message.details.exitCode))
        view.exitCode = message.details.exitCode;
    }
    state.messages.push(view);
    afterEntryId = entry.id;
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
