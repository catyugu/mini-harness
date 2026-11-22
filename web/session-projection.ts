import type { RunInfo, ViewMessage } from '../src/protocol.js';

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
