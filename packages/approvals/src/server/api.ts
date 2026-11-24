import type {} from 'cordis';
import { extension, type ContributionSource } from '@mini-harness/kernel/contributions';

export interface ApprovalOptions {
  title: string;
  message: string;
  context?: string;
  signal?: AbortSignal;
  /** Permit the user's Full access selection to resolve this particular request. */
  allowFullAccess?: boolean;
}

export interface ApprovalAccess {
  /** Resolves true for automatic approval, false for explicit approval, rejects on denial or cancellation. */
  request(sessionId: string, options: ApprovalOptions): Promise<boolean>;
}

export const bindApproval = Symbol.for('mini-harness.approvalAccess');
interface ApprovalProvider { [bindApproval](source: ContributionSource): ApprovalAccess }

export const approvalExtensions = {
  access: extension((source) => source.service('harnessApprovals')[bindApproval](source))
};

export interface ApprovalPort extends ApprovalProvider {
  readonly events: EventTarget;
  has(id: string): boolean;
  approveSession(id: string): void;
}

declare module 'cordis' {
  interface Context { harnessApprovals: ApprovalPort }
}
declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessApprovals: ApprovalProvider }
}
