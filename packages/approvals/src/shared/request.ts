export interface Approval {
  id: string;
  sessionId: string;
  runId?: string;
  plugin: string;
  title: string;
  message: string;
  createdAt: string;
}
