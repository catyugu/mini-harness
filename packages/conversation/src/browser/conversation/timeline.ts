import type { HistoryEntry, MessageContent, ViewMessage } from '@mini-harness/sessions/message';
import type { LiveRecord, ToolProgress } from '@mini-harness/runs/stream';
import type { MessageActionTarget } from '../history-api.ts';

export const textOf = (content: MessageContent = []) =>
  content.filter((part) => part.type === 'text').map(({ text }) => text).join('\n');

export function hasContent(entry: HistoryEntry) {
  if (entry.type !== 'message' || entry.role === 'toolResult') return true;
  if (entry.role === 'user' ? entry.attachments.length : entry.error) return true;
  return entry.content.some((part) => part.type === 'text' && Boolean(part.text));
}

type TurnPart =
  | { type: 'text' | 'error'; id: string; text: string }
  | { type: 'partial' }
  | Extract<HistoryEntry, { type: 'record' } | { role: 'toolResult' }>
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
  records: readonly LiveRecord[],
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
    if (entry.type === 'record') {
      if (entry.runId) response(entry.id, entry.runId).parts.push(entry);
      else (turn?.parts ?? rows).push(entry);
      continue;
    }
    const { parts } = response(entry.id, entry.runId);
    if (entry.role === 'toolResult') {
      parts.push(entry);
      continue;
    }
    assistant.push(entry);
    const blocks = entry.content;
    let adjacent = true;
    for (const [index, block] of blocks.entries()) {
      const id = entry.id + ':' + index;
      if (block.type === 'text' && block.text) {
        const previous = parts.at(-1);
        if (adjacent && previous?.type === 'text') previous.text += (index === 0 ? '\n\n' : '') + block.text;
        else parts.push({ type: 'text', id, text: block.text });
        adjacent = true;
      } else {
        adjacent = false;
      }
    }
    if (entry.error) parts.push({ type: 'error', id: entry.id, text: entry.error });
  }
  for (const entry of records) {
    response(entry.id, entry.runId ?? runId).parts.push(entry);
  }
  if (partial || tools.length) {
    const { parts } = response('pending', runId);
    if (partial) parts.push({ type: 'partial' });
    parts.push(...tools);
  }
  finish();
  return rows;
}
