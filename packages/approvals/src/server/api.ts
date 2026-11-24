import type {} from 'cordis';

export interface ApprovalPort {
  readonly events: EventTarget;
  has(id: string): boolean;
  request(sessionId: string, runId: string | undefined, command: string, signal?: AbortSignal, context?: string): Promise<boolean>;
  approveSession(id: string): void;
}

declare module 'cordis' {
  interface Context { harnessApprovals: ApprovalPort }
}
