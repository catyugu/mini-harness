import { userContent } from './user-content.ts';
import type { SessionDisplayRecord } from './shared/display-record.ts';
import { isRunning, type RunInfo } from './shared/run-state.ts';
import { toolResultState } from '@mini-harness/tools/api';
import type { NativeMessage, NativeToolMessage } from '@mini-harness/llm/api';
import type { MessageContent, ViewMessage } from './shared/message.ts';
import type { ContextReplacement, SessionContext, SessionEntry, SessionEvent, SessionProjection } from './log-api.ts';
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
    if (entry.origin) view.origin = entry.origin;
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
    if (typeof message.details?.taskId === 'string') view.taskId = message.details.taskId;
    if (typeof message.details?.sessionId === 'string') view.sessionId = message.details.sessionId;
    if (typeof message.details?.exitCode === 'number' && Number.isInteger(message.details.exitCode))
      view.exitCode = message.details.exitCode;
  }
  return view;
}

/** Select content explicitly from the event, without interpreting its business meaning. */
export function displayContent(event: SessionEvent): unknown {
  const display = event.display;
  if (!display) return;
  if (!display.source) return display.content;
  let value: unknown = event;
  for (const key of display.source) {
    if (
      (typeof key !== 'string' && (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0)) ||
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key)
    )
      throw new Error('Invalid record display source');
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

export function displayRecord(entry: SessionEntry): SessionDisplayRecord | undefined {
  if (!entry.display) return;
  const { owner, kind, title } = entry.display;
  return {
    type: 'record',
    id: entry.id,
    plugin: owner.pluginId,
    instanceId: owner.instanceId,
    kind,
    title,
    content: displayContent(entry),
  };
}

export function newContext(): SessionContext {
  return { leafId: null, contextMessages: [], contextEntryIds: [] };
}

export function applyReplacements(
  { contextMessages, contextEntryIds }: SessionContext,
  replacements: ContextReplacement[],
  id: string,
) {
  let end = contextMessages.length;
  for (const { start, deleteCount, insert, preserveSource } of replacements) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(deleteCount) ||
      start < 0 ||
      deleteCount < 1 ||
      start + deleteCount > end ||
      !Array.isArray(insert) ||
      (preserveSource && insert.length !== deleteCount)
    )
      throw new Error('Invalid context replacement interval');
    end = start;
    contextMessages.splice(start, deleteCount, ...insert);
    if (!preserveSource) contextEntryIds.splice(start, deleteCount, ...insert.map(() => id));
  }
}

export function projectContextEntry(state: SessionContext, entry: SessionEntry, message?: NativeMessage) {
  state.leafId = entry.id;
  if (entry.type === 'model') state.model = entry.model;
  if (entry.type === 'thinking') state.thinkingLevel = entry.level ?? undefined;
  if (entry.type === 'message' && entry.selection) {
    state.model = entry.selection.model;
    state.thinkingLevel = entry.selection.thinkingLevel;
  }
  if (message) {
    state.contextMessages.push(message);
    state.contextEntryIds.push(entry.id);
    return;
  }
  if (entry.type === 'context-replace') applyReplacements(state, entry.replacements, entry.id);
}

/** Read projections are pure and never write synthetic history back into the transcript. */
export function projectLog(
  branch: SessionEntry[],
  execution: (id: string) => NativeToolMessage | undefined,
  runs: readonly { seq: number; parentId: string | null; run: RunInfo }[],
  context: SessionContext,
): SessionProjection {
  const state: SessionProjection = { ...context, timeline: [] };
  const lastRun = runs.at(-1)?.run;
  if (lastRun) state.run = lastRun;
  const messageOf = (entry: SessionEntry) => projectMessage(entry, execution);
  const calls = new Map<string, unknown>();
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
    const record = displayRecord(entry);
    if (record) state.timeline.push(record);
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
  return state;
}
