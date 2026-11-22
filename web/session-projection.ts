import type { RunEvent, RunInfo, SessionFact, StreamEvent, ViewMessage } from '../src/protocol.js';

export interface TurnProjection {
  id: string;
  user: ViewMessage;
  process: ViewMessage[];
  final?: ViewMessage;
  run?: RunInfo;
  state: RunInfo['state'] | 'unknown';
}

/** Pi messages own the content; supplementary run facts only qualify its state. */
export function projectTurns(messages: ViewMessage[], runs: RunInfo[] = []): TurnProjection[] {
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const turns: TurnProjection[] = [];
  let turn: TurnProjection;
  for (const message of messages) {
    if (message.role === 'user') {
      turn = { id: message.id ?? 'user:' + message.timestamp, user: message, process: [],
        run: byRun.get(message.runId), state: byRun.get(message.runId)?.state ?? 'unknown' };
      turns.push(turn);
    } else if (turn) turn.process.push(message);
  }
  for (const item of turns) {
    const last = item.process.at(-1);
    if (last?.role === 'assistant' && !last.error && !hasToolCalls(last)) {
      item.final = item.process.pop();
    }
  }
  return turns;
}

export function hasToolCalls(message: ViewMessage) {
  return Array.isArray(message.content) && message.content.some(({ type }) => type === 'toolCall');
}

export function textContent(message: Pick<ViewMessage, 'content'>) {
  return typeof message.content === 'string' ? message.content : message.content.filter(({ type }) => type === 'text').map(({ text }) => text ?? '').join('\n');
}


type LiveTool = Extract<StreamEvent, { type: 'tool' }>;

export function sessionProjection(messages: ViewMessage[] = [], runs: RunInfo[] = [], facts: SessionFact[] = [], tools: LiveTool[] = []) {
  return { messages, runs, facts, tools: new Map(tools.map((tool) => [tool.id, tool])) };
}

export function mergeSessionEvent(history: ReturnType<typeof sessionProjection>, event: RunEvent): { message?: ViewMessage } | undefined {
  let message: ViewMessage;
  switch (event.type) {
    case 'user':
      message = { role: 'user', content: event.content ?? event.text, timestamp: Date.now(), ...event.entry };
      break;
    case 'assistant-end':
      message = event.message;
      break;
    case 'tool':
      if (event.state === 'running') {
        history.tools.set(event.id, event);
        return {};
      }
      history.tools.delete(event.id);
      if (!event.entry) return {};
      message = { ...event.entry, role: 'toolResult', toolCallId: event.id, toolName: event.name,
        isError: event.state === 'error', content: event.content ?? [], details: event.details, arguments: event.arguments,
        elapsedMs: event.elapsedMs, sessionId: event.sessionId };
      break;
    case 'approval':
      if (!event.fact || history.facts.some(({ id }) => id === event.fact.id)) return;
      history.facts.push({ id: event.fact.id, timestamp: event.fact.timestamp, kind: 'approval', data: { ...event.approval, runId: event.fact.runId } });
      return {};
    case 'snapshot':
      Object.assign(history, sessionProjection(event.messages, event.runs ?? history.runs, event.facts ?? history.facts, event.tools));
      // Apply the snapshot's latest run after replacing the history.
    case 'run': {
      const index = history.runs.findIndex(({ id }) => id === event.run.id);
      if (index < 0) history.runs.push(event.run);
      else history.runs[index] = event.run;
      return {};
    }
    default: return;
  }
  if (!message || (message.id && history.messages.some(({ id }) => id === message.id))) return;
  history.messages.push(message);
  return { message };
}
