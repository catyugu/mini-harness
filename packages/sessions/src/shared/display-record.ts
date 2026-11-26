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
}

export interface RecordAppend {
  leafId: string;
  records: SessionDisplayRecord[];
}

/** Producer-facing live publication; the run owns the stream state and wire protocol. */
export interface RecordPublisher {
  set(record: SessionDisplayRecord): void;
  append(id: string, channel: string, text: string): void;
  remove(id: string): void;
}
