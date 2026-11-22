import { randomUUID } from 'node:crypto';
export interface Approval { id: string; sessionId: string; command: string; toolCallId?: string; createdAt: string }
export interface ApprovalEvent extends Approval { state: 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled' }
export class Approvals {
  private pending = new Map<string, { info: Approval; settle: (state: ApprovalEvent['state']) => void }>();
  constructor(private changed: (event: ApprovalEvent) => void = () => {}) {}
  list() { return [...this.pending.values()].map(({ info }) => ({ ...info })); }
  request(sessionId: string, command: string, signal?: AbortSignal, toolCallId?: string): Promise<void> {
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const info = { id: randomUUID(), sessionId, command, toolCallId, createdAt: new Date().toISOString() };
      let finished = false;
      const finish = (state: ApprovalEvent['state']) => {
        if (finished) return;
        finished = true;
        this.pending.delete(info.id); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.changed({ ...info, state });
        if (state === 'allowed') resolve(); else reject(new Error(state === 'cancelled' ? 'Operation cancelled' : 'Shell operation denied or approval expired'));
      };
      const abort = () => finish('cancelled');
      const timer = setTimeout(() => finish('expired'), 5 * 60 * 1000); timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(info.id, { info, settle: finish });
      this.changed({ ...info, state: 'pending' });
      if (signal?.aborted) abort();
    });
  }
  decide(id: string, allowed: boolean) {
    const request = this.pending.get(id);
    if (!request) throw new Error('Approval is no longer pending');
    request.settle(allowed ? 'allowed' : 'denied');
  }
  close() { for (const request of this.pending.values()) request.settle('cancelled'); }
}
