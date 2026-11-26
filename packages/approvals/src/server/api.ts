import type { Approval } from '../shared/request.ts';

export class ApprovalDenied extends Error {}

export interface ApprovalPrompt {
  title: string;
  message: string;
  /** Allow the user to release this request by explicitly selecting Full access. */
  followFullAccess?: boolean;
  /** Scope repeated denials within this run to this operation. */
  context?: string;
}

export interface ApprovalRequests {
  request(id: string, prompt: ApprovalPrompt, signal?: AbortSignal, executionId?: string): Promise<boolean>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessApprovalRequests: ApprovalRequests;
  }
}

export interface ApprovalPort {
  readonly events: EventTarget;
  has(id: string): boolean;
  list(): Approval[];
  decide(id: string, allowed: boolean): void;
  approveSession(id: string): void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessApprovals: ApprovalPort;
  }
}
