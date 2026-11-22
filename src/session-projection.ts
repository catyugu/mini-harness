import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { RunInfo, SessionFact, ViewMessage } from './protocol.js';

export function projectMessage({ id, message }: SessionMessageEntry, runId: string, args?: unknown): ViewMessage | undefined {
  const { role } = message;
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return;
  const base = { id, runId, role, content: message.content, timestamp: message.timestamp };
  if (role === 'assistant') return { ...base, error: message.errorMessage,
    usage: message.usage?.totalTokens > 0 ? message.usage : undefined };
  if (role === 'toolResult') {
    const { details, durationMs, toolName, toolCallId, isError } = message;
    return { ...base, details, elapsedMs: durationMs, arguments: args, toolName, toolCallId, isError,
      sessionId: details && typeof details === 'object' && 'sessionId' in details && typeof details.sessionId === 'string' ? details.sessionId : undefined };
  }
  return base;
}

export function projectSession(entries: SessionEntry[], latest?: RunInfo) {
  const messages: ViewMessage[] = [];
  const runs = new Map<string, RunInfo>();
  const facts: SessionFact[] = [];
  const args = new Map<string, unknown>();
  let runId: string;
  for (const entry of entries) {
    if (entry.type === 'custom') {
      if (entry.customType === 'mini-harness.run') {
        const run = entry.data as RunInfo;
        runId = run.id;
        runs.set(runId, { ...run });
      }
      if (entry.customType === 'mini-harness.approval') facts.push({ id: entry.id, kind: 'approval', timestamp: entry.timestamp, data: entry.data });
    } else if (entry.type === 'message') {
      const { message } = entry;
      if (message.role === 'assistant')
        for (const block of message.content) if (block.type === 'toolCall') args.set(block.id, block.arguments);
      const projected = projectMessage(entry, runId, message.role === 'toolResult' ? args.get(message.toolCallId) : undefined);
      if (projected) messages.push(projected);
    }
  }
  if (latest) runs.set(latest.id, latest);
  return { messages, runs: [...runs.values()], facts };
}
