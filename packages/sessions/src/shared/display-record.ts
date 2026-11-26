export interface RecordAppend {
  leafId: string;
  display?: SessionDisplayRecord | ContextCheckpoint;
}

export interface SessionDisplayRecord {
  type: 'record';
  id: string;
  plugin: string;
  instanceId: string;
  title: string;
  content?: unknown;
}

/** The visible result of a committed summarizing context replacement. */
export interface ContextCheckpoint {
  type: 'checkpoint';
  id: string;
  summary: string;
}
