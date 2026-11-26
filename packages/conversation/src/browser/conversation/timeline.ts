import type { HistoryEntry, MessageContent, ViewMessage } from '@mini-harness/sessions/message';
import type { ToolProgress } from '@mini-harness/runs/stream';
import type { MessageActionTarget } from '../history-api.ts';

export const textOf = (content?: MessageContent) =>
  typeof content === 'string'
    ? content
    : (content
        ?.filter((part) => part.type === 'text')
        .map(({ text }) => text)
        .join('\n') ?? '');

export function hasContent(entry: HistoryEntry) {
  if (entry.type !== 'message' || entry.role === 'toolResult') return true;
  if (entry.attachments?.length || entry.error) return true;
  return typeof entry.content === 'string'
    ? Boolean(entry.content)
    : entry.content.some((part) =>
        part.type === 'text'
          ? Boolean(part.text)
          : part.type === 'thinking'
            ? Boolean(part.thinking && !part.redacted)
            : false,
      );
}

type TurnPart =
  | { type: 'text' | 'thinking' | 'error'; id: string; text: string }
  | { type: 'partial' }
  | Extract<HistoryEntry, { type: 'record' | 'checkpoint' } | { role: 'toolResult' }>
  | ToolProgress;

interface Turn {
  type: 'turn';
  id: string;
  runId?: string;
  parts: TurnPart[];
  target?: Extract<MessageActionTarget, { type: 'assistant-turn' }>;
}

type HistoryRow = Exclude<HistoryEntry, { role: 'assistant' | 'toolResult' }> | Turn;

export function groupHistory(
  entries: readonly HistoryEntry[],
  runId: string | undefined,
  partial: string,
  tools: readonly ToolProgress[],
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let turn: Turn | undefined;
  let assistant: ViewMessage[] = [];

  function finish() {
    if (turn?.parts.length) {
      if (assistant.length) {
        turn.target = {
          type: 'assistant-turn',
          id: assistant[0].id,
          messages: assistant,
          rawText: turn.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n'),
        };
      }
      rows.push(turn);
    }
    turn = undefined;
    assistant = [];
  }

  function response(id: string, runId?: string) {
    if (turn?.runId !== runId) finish();
    return (turn ??= { type: 'turn', id, runId, parts: [] });
  }

  for (const entry of entries) {
    if (entry.type === 'termination' || (entry.type === 'message' && entry.role === 'user')) {
      finish();
      if (hasContent(entry)) rows.push(entry);
      continue;
    }
    if (entry.type === 'record' || entry.type === 'checkpoint') {
      (turn?.parts ?? rows).push(entry);
      continue;
    }
    const { parts } = response(entry.id, entry.runId);
    if (entry.role === 'toolResult') {
      parts.push(entry);
      continue;
    }
    assistant.push(entry);
    const blocks =
      typeof entry.content === 'string' ? [{ type: 'text', text: entry.content }] : entry.content;
    let adjacent = true;
    for (const [index, block] of blocks.entries()) {
      const id = entry.id + ':' + index;
      if (block.type === 'text' && block.text) {
        const previous = parts.at(-1);
        if (adjacent && previous?.type === 'text') previous.text += (index === 0 ? '\n\n' : '') + block.text;
        else parts.push({ type: 'text', id, text: block.text });
        adjacent = true;
      } else {
        if (block.type === 'thinking' && block.thinking && !block.redacted)
          parts.push({ type: 'thinking', id, text: block.thinking });
        adjacent = false;
      }
    }
    if (entry.error) parts.push({ type: 'error', id: entry.id, text: entry.error });
  }
  if (partial || tools.length) {
    const { parts } = response('pending', runId);
    if (partial) parts.push({ type: 'partial' });
    parts.push(...tools);
  }
  finish();
  return rows;
}
