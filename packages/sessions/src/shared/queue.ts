export interface QueueEntry {
  id: string;
  mode: 'steer' | 'followUp';
  summary: string;
  state: 'pending' | 'failed';
  reason?: string;
}
