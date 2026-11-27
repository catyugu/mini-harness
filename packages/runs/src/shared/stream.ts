import type { NativeToolMessage } from '@mini-harness/llm/api';
import type { ViewMessage } from '@mini-harness/sessions/message';
import type {
  RecordAppend,
  RecordPublisher,
  SessionDisplayRecord,
} from '@mini-harness/sessions/display-record';
import type { InputSource } from '@mini-harness/input/message';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { SessionProjection } from '@mini-harness/sessions/log-api';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export type StreamEvent =
  | RunStreamEvent
  | { type: 'run'; run: RunInfo }
  | ({ type: 'branch' } & RecordAppend)
  | ({
      type: 'snapshot';
      partial?: string;
      tools?: ToolProgress[];
      records: LiveRecord[];
      run: RunInfo;
    } & Pick<SessionProjection, 'timeline' | 'model' | 'thinkingLevel' | 'leafId'>);

export interface ToolProgress {
  type: 'tool';
  id: string;
  name: string;
  state: 'approval' | 'running';
  arguments?: unknown;
  content?: NativeToolMessage['content'];
  streams?: Readonly<Record<string, string>>;
}

export interface ToolOutput {
  type: 'tool-output';
  id: string;
  channel: string;
  text: string;
}

export type RunEvent = StreamEvent & { runId: string; runSessionId: string; sequence: number };

export type RunStreamEvent =
  | RecordUpdate
  | { type: 'assistant-start' }
  | { type: 'assistant-end'; message: Extract<ViewMessage, { role: 'assistant' }> }
  | { type: 'tool-end'; message: Extract<ViewMessage, { role: 'toolResult' }> }
  | {
      type: 'user';
      source: InputSource;
      model: ModelChoice;
      thinkingLevel?: import('@mini-harness/llm/vocabulary').ThinkingLevel;
      revised: boolean;
      message: Extract<ViewMessage, { role: 'user' }>;
    }
  | { type: 'delta' | 'complete'; text: string }
  | ToolProgress
  | ToolOutput
  | { type: 'error'; error: string };

/** Runtime-only record channels are never part of the durable history projection. */
export type LiveRecord = SessionDisplayRecord & { streams?: Readonly<Record<string, string>> };

/** Volatile presentation updates. Only the producer interprets its data and channel names. */
export type RecordUpdate =
  | { type: 'record-update'; operation: 'set'; record: LiveRecord }
  | { type: 'record-update'; operation: 'append'; id: string; channel: string; text: string }
  | { type: 'record-update'; operation: 'remove'; id: string };

/** Shared by the live snapshot owner and its browser replica. Upserts preserve record order. */
export function updateRecords(records: readonly LiveRecord[], event: RecordUpdate): LiveRecord[] {
  const id = event.operation === 'set' ? event.record.id : event.id;
  const index = records.findIndex((record) => record.id === id);
  if (event.operation === 'remove') return records.filter((record) => record.id !== id);
  const next = [...records];
  if (event.operation === 'set') {
    next.splice(index < 0 ? next.length : index, index < 0 ? 0 : 1, event.record);
  } else {
    if (index < 0) throw new Error('Record has not been opened: ' + id);
    const record = next[index];
    const streams = record.streams ?? {};
    next[index] = {
      ...record,
      streams: {
        ...streams,
        [event.channel]: (Object.hasOwn(streams, event.channel) ? streams[event.channel] : '') + event.text,
      },
    };
  }
  return next;
}

/** The owner and browser replica reduce the same tool events. Output snapshots retain a bounded tail. */
export function updateTools(
  tools: readonly ToolProgress[],
  event: ToolProgress | ToolOutput | Extract<RunStreamEvent, { type: 'tool-end' }>,
): ToolProgress[] {
  if (event.type === 'tool-end') return tools.filter(({ id }) => id !== event.message.toolCallId);
  const index = tools.findIndex(({ id }) => id === event.id);
  const next = [...tools];
  if (event.type === 'tool') {
    const streams = tools[index]?.streams;
    next.splice(index < 0 ? next.length : index, index < 0 ? 0 : 1, { ...event, streams });
  } else {
    if (index < 0) throw new Error('Tool has not been started: ' + event.id);
    const tool = tools[index];
    const streams = tool.streams ?? {};
    const previous = Object.hasOwn(streams, event.channel) ? streams[event.channel] : '';
    next[index] = {
      ...tool,
      streams: { ...streams, [event.channel]: (previous + event.text).slice(-1048576) },
    };
  }
  return next;
}

/** Both the scoped agent observer and public Runs service use the same producer port. */
export function recordPublisher(emit: (event: RecordUpdate) => void): RecordPublisher {
  return {
    set: (record) => emit({ type: 'record-update', operation: 'set', record }),
    append: (id, channel, text) => emit({ type: 'record-update', operation: 'append', id, channel, text }),
    remove: (id) => emit({ type: 'record-update', operation: 'remove', id }),
  };
}
