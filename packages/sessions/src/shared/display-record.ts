import type { SessionDisplayRecord } from '@mini-harness/plugin-api/timeline';
export type { RecordOwner, RecordDisplay, RecordPresentation, SessionDisplayRecord, RecordUpdate } from '@mini-harness/plugin-api/timeline';

export interface RecordAppend {
  leafId: string;
  display?: SessionDisplayRecord;
}
