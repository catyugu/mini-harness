export interface RecordAppend {
  leafId: string;
  display?: SessionDisplayRecord;
}

export interface SessionDisplayRecord {
  type: 'record';
  id: string;
  plugin: string;
  instanceId: string;
  title: string;
  content?: unknown;
}
