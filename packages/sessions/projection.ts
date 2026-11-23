import type { NativeMessage } from '@mini-harness/contracts/llm';
import type { MessageContent, ViewMessage } from '@mini-harness/contracts/message';
import type { InboxItem, SessionEntry, SessionProjection } from '@mini-harness/contracts/session-log';

/** Read projections are pure and never write synthetic history back into the transcript. */
export function projectLog(entries: SessionEntry[], branch: SessionEntry[]): SessionProjection {
  const state: SessionProjection = { leafId: branch.at(-1)?.id ?? null, messages: [], contextMessages: [], contextEntryIds: [],
    thinkingLevel: 'off', inbox: [] };
  const inbox = new Map<string, InboxItem>();
  for (const entry of entries) {
    if (entry.type === 'run') state.run = entry.run;
    if (entry.type === 'inbox-enqueued') inbox.set(entry.item.id, entry.item);
    if (entry.type === 'inbox-consumed' || entry.type === 'inbox-cancelled') for (const id of entry.ids) inbox.delete(id);
    if (entry.type === 'message' && entry.inboxId) inbox.delete(entry.inboxId);
  }
  state.inbox = [...inbox.values()];
  const calls = new Map<string, unknown>();
  const edits = new Map<string, NativeMessage['content'] | null>();
  let compaction: Extract<SessionEntry, { type: 'compaction' }>;
  for (const entry of branch) {
    if (entry.type === 'model') state.model = entry.model;
    if (entry.type === 'thinking') state.thinkingLevel = entry.level;
    if (entry.type === 'compaction') compaction = entry;
    if (entry.type === 'context-edit') edits.set(entry.targetId, entry.replacement);
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'assistant') for (const block of message.content)
      if (block.type === 'toolCall') calls.set(block.id, block.arguments);
    const view: ViewMessage = { id: entry.id, parentId: entry.parentId,
      role: message.role, content: message.content as MessageContent, timestamp: message.timestamp };
    if (message.role === 'user' && entry.presentation) {
      view.attachments = entry.presentation.attachments;
      view.content = typeof message.content === 'string' ? entry.presentation.userText :
        [...(entry.presentation.userText ? [{ type: 'text', text: entry.presentation.userText }] : []),
          ...message.content.filter((block) => block.type === 'image')];
    }
    if (message.role === 'assistant') view.error = message.errorMessage;
    if (message.role === 'toolResult') {
      view.toolName = message.toolName;
      view.toolCallId = message.toolCallId;
      view.isError = message.isError;
      view.arguments = calls.get(message.toolCallId);
      view.elapsedMs = entry.elapsedMs ?? message.elapsedMs;
      if (typeof message.details?.sessionId === 'string') view.sessionId = message.details.sessionId;
      if (typeof message.details?.exitCode === 'number' && Number.isInteger(message.details.exitCode)) view.exitCode = message.details.exitCode;
    }
    state.messages.push(view);
  }
  let context = branch;
  if (compaction) {
    const from = compaction.keepFromId && branch.findIndex(({ id }) => id === compaction.keepFromId);
    context = typeof from === 'number' && from >= 0 ? branch.slice(from) : branch.slice(branch.indexOf(compaction) + 1);
    state.contextMessages.push({ role: 'user', content: 'Summary of earlier conversation:\n' + compaction.summary,
      timestamp: Date.parse(compaction.timestamp) });
    state.contextEntryIds.push(compaction.id);
  }
  state.contextMessages.push(...context.flatMap<NativeMessage>((entry) => {
    if (entry.type !== 'message' || edits.get(entry.id) === null) return [];
    state.contextEntryIds.push(entry.id);
    return [{ ...entry.message, ...(edits.has(entry.id) ? { content: edits.get(entry.id) } : {}) } as NativeMessage];
  }));
  return state;
}
