export interface RecordOwner {
  pluginId: string;
  instanceId: string;
}

export type RecordDisplay = {
  kind: string;
  title: string;
  id?: string;
} & ({ content?: unknown; source?: never } | { source: (string | number)[]; content?: never });

export type RecordPresentation = RecordDisplay & { owner: RecordOwner };

export interface SessionDisplayRecord {
  type: 'record';
  id: string;
  plugin: string;
  instanceId: string;
  kind: string;
  title: string;
  content?: unknown;
  runId?: string;
  streams?: Readonly<Record<string, string>>;
}

/** Volatile presentation updates. Only the producer interprets its data and channel names. */
export type RecordUpdate =
  | { type: 'record-update'; operation: 'set'; record: SessionDisplayRecord }
  | { type: 'record-update'; operation: 'append'; id: string; channel: string; text: string }
  | { type: 'record-update'; operation: 'remove'; id: string };

/** Shared by the live snapshot owner and its browser replica. Upserts preserve record order. */
export function updateRecords(records: readonly SessionDisplayRecord[], event: RecordUpdate): SessionDisplayRecord[] {
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
    next[index] = { ...record, streams: { ...streams, [event.channel]: (Object.hasOwn(streams, event.channel) ? streams[event.channel] : '') + event.text } };
  }
  return next;
}
