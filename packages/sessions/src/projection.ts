import { userContent } from './user-content.ts';
import type { RecordPresentation, SessionDisplayRecord } from './shared/display-record.ts';
import { isRunning, type RunInfo } from './shared/run-state.ts';
import type { NativeMessage, NativeToolMessage } from '@mini-harness/llm/api';
import type { ViewMessage } from './shared/message.ts';
import type {
  ContextReplacement,
  SessionContext,
  SessionEntry,
  SessionEvent,
  SessionProjection,
} from './log-api.ts';
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
    timestamp: message.timestamp,
  };
  switch (message.role) {
    case 'user':
      return {
        ...fields,
        role: 'user',
        ...userContent(message.content, entry.type === 'message' ? entry.presentation : undefined),
        ...(entry.type === 'message' && {
          submissionId: entry.submissionId,
          inboxId: entry.inboxId,
          origin: entry.origin,
        }),
      };
    case 'assistant':
      return {
        ...fields,
        role: 'assistant',
        content: message.content,
        error: !runId && message.stopReason !== 'aborted' ? message.errorMessage : undefined,
      };
    case 'toolResult': {
      const { details, detailKeys } = message;
      return {
        ...fields,
        role: 'toolResult',
        content: message.content,
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        toolState: message.state,
        arguments: toolArguments,
        elapsedMs: (entry.type === 'message' ? entry.elapsedMs : undefined) ?? message.elapsedMs,
        details: details && detailKeys
          ? Object.fromEntries(detailKeys.filter((key) => Object.hasOwn(details, key)).map((key) => [key, details[key]]))
          : undefined,
      };
    }
  }
}

/** Select content explicitly from the event, without interpreting its business meaning. */
export function displayContent(event: SessionEvent, display: RecordPresentation): unknown {
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

export function displayRecords(entry: SessionEntry, runId?: string): SessionDisplayRecord[] {
  return (entry.displays ?? []).map((display, index, all) => ({
    type: 'record',
    id: display.id ?? (all.length === 1 ? entry.id : entry.id + ':' + index),
    ...(runId && { runId }),
    plugin: display.owner.pluginId,
    instanceId: display.owner.instanceId,
    kind: display.kind,
    title: display.title,
    content: displayContent(entry, display),
  }));
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
    state.timeline.push(...displayRecords(entry, runId));
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
