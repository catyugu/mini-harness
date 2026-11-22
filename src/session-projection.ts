import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { RunInfo, ViewMessage } from './protocol.js';

export function projectMessage({ id, message }: SessionMessageEntry, runId: string, toolArgs: Map<string, unknown>): ViewMessage | undefined {
  const { role } = message;
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return;
  const base = { id, runId, role, content: message.content, timestamp: message.timestamp };
  if (role === 'assistant') {
    for (const block of message.content) if (block.type === 'toolCall') toolArgs.set(block.id, block.arguments);
    return { ...base, error: message.errorMessage, usage: message.usage?.totalTokens > 0 ? message.usage : undefined };
  }
  if (role === 'toolResult') {
    const { details, durationMs, toolName, toolCallId, isError } = message;
    const args = toolArgs.get(toolCallId);
    toolArgs.delete(toolCallId);
    return { ...base, details, elapsedMs: durationMs, arguments: args, toolName, toolCallId, isError,
      sessionId: details && typeof details === 'object' && 'sessionId' in details && typeof details.sessionId === 'string' ? details.sessionId : undefined };
  }
  return base;
}

export function projectSession(entries: SessionEntry[], latest?: RunInfo) {
  const messages: ViewMessage[] = [];
  const runs = new Map<string, RunInfo>();
  const args = new Map<string, unknown>();
  let runId: string;
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'mini-harness.run') {
      const run = entry.data as RunInfo;
      runId = run.id;
      runs.set(runId, { ...run });
    } else if (entry.type === 'message') {
      const projected = projectMessage(entry, runId, args);
      if (projected) messages.push(projected);
    }
  }
  if (latest) runs.set(latest.id, latest);
  return { messages, runs: [...runs.values()] };
}
