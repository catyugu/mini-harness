import type {} from 'cordis';
import { ToolApprovalDenied } from '@mini-harness/tools/api';
import { extension } from '@mini-harness/kernel/contributions';

export interface ApprovalPrompt {
  title: string;
  message: string;
  /** Allow the user to release this request by explicitly selecting Full access. */
  followFullAccess?: boolean;
  /** Scope repeated denials within this run to this operation. */
  context?: string;
}

export const requestApproval = Symbol.for('mini-harness.requestApproval');
export interface ApprovalRequests {
  [requestApproval](id: string, plugin: string, prompt: ApprovalPrompt, signal: AbortSignal): Promise<boolean>;
}

declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessApprovalRequests: ApprovalRequests }
}

export const approvalExtensions = {
  request: extension((source) => {
    const requests = source.service('harnessApprovalRequests');
    return (id: string, prompt: ApprovalPrompt, signal?: AbortSignal) => source.run('request approval', (lifetime) => {
      if (!source.visible(id)) throw new Error('Conversation outside plugin scope');
      return requests[requestApproval](id, source.instanceId, prompt, lifetime);
    }, signal).catch((error: unknown) => {
      if (error instanceof Error && error.cause instanceof ToolApprovalDenied) throw error.cause;
      throw error;
    });
  })
};

export interface ApprovalPort {
  readonly events: EventTarget;
  has(id: string): boolean;
  approveSession(id: string): void;
}

declare module 'cordis' {
  interface Context { harnessApprovals: ApprovalPort }
}
