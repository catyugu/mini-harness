import type { Approval } from '../shared/request.ts';

import type { ToolApproval } from '@mini-harness/tools/api';

export type ApprovalPrompt = ToolApproval;

export interface ApprovalRequests {
  request(id: string, prompt: ApprovalPrompt, signal?: AbortSignal): Promise<boolean>;
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
