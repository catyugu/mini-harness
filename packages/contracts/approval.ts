export class ApprovalDenied extends Error {
  constructor() { super('Shell operation denied'); }
}

export interface Approval { id: string; sessionId: string; runId?: string; command: string; createdAt: string }
