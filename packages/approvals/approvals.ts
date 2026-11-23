import { randomUUID } from 'node:crypto';
import { ApprovalDenied, type Approval } from '@mini-harness/contracts/approval';
export class Approvals {
  private pending = new Map<string, { info: Approval; settle: (decision: 'allow' | 'deny' | 'expired' | 'cancelled') => void }>();
  private readonly denials = new Map<string, Set<string>>();
  readonly events = new EventTarget();
  private changed(id: string) { this.events.dispatchEvent(new CustomEvent('change', { detail: { id } })); }
  has(sessionId: string) { return [...this.pending.values()].some(({ info }) => info.sessionId === sessionId); }
  list() { return [...this.pending.values()].map(({ info }) => ({ ...info })); }
  request(sessionId: string, runId: string | undefined, command: string, signal?: AbortSignal, context?: string): Promise<void> {
    signal?.throwIfAborted();
    const key = context === undefined ? undefined : JSON.stringify([sessionId, context, command]);
    if (runId && key && this.denials.get(runId)?.has(key)) return Promise.reject(new ApprovalDenied());
    return new Promise<void>((resolve, reject) => {
      const info = { id: randomUUID(), sessionId, runId, command, createdAt: new Date().toISOString() };
      const finish = (decision: 'allow' | 'deny' | 'expired' | 'cancelled') => {
        this.pending.delete(info.id); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.changed(sessionId);
        if (decision === 'allow') resolve();
        else if (decision === 'deny') {
          if (runId && key) {
            const previous = this.denials.get(runId) ?? new Set();
            previous.add(key);
            this.denials.set(runId, previous);
          }
          reject(new ApprovalDenied());
        } else reject(new Error(decision === 'expired' ? 'Shell approval expired' : 'Operation cancelled'));
      };
      const abort = () => finish('cancelled');
      const timer = setTimeout(() => finish('expired'), 5 * 60 * 1000); timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(info.id, { info, settle: finish });
      this.changed(sessionId);
    });
  }
  decide(id: string, allowed: boolean) {
    const request = this.pending.get(id);
    if (!request) throw new Error('Approval is no longer pending');
    request.settle(allowed ? 'allow' : 'deny');
  }
  finishRun(runId: string) { this.denials.delete(runId); }
  close() {
    for (const request of this.pending.values()) request.settle('cancelled');
    this.denials.clear();
  }
}
