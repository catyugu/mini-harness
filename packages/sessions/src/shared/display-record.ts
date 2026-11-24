export interface SessionDisplayRecord {
  id: string;
  plugin: string;
  instanceId: string;
  /** The preceding message on the selected branch, or null before the first message. */
  afterMessageId: string | null;
  title: string;
  content?: unknown;
}
