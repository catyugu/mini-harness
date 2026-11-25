import type { Approval } from "../shared/request.js";
import type {} from 'mini-harness/cordis';

export interface ApprovalPrompt {
  title: string;
  message: string;
  /** Allow the user to release this request by explicitly selecting Full access. */
  followFullAccess?: boolean;
  /** Scope repeated denials within this run to this operation. */
  context?: string;
}

export interface ApprovalRequests {
  request(id: string, prompt: ApprovalPrompt, signal?: AbortSignal): Promise<boolean>;
}

declare module 'mini-harness/cordis' {
  interface Context { harnessApprovalRequests: ApprovalRequests }
}

export interface ApprovalPort {
  readonly events: EventTarget;
  has(id: string): boolean;
  list(): Approval[];
  decide(id: string, allowed: boolean): void;
  approveSession(id: string): void;
}

declare module 'mini-harness/cordis' {
  interface Context { harnessApprovals: ApprovalPort }
}
