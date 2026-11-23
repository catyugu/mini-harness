import { randomUUID } from 'node:crypto';
import type { Approval } from '#mini-harness/contracts/approval.js';
export class Approvals {
  private pending = new Map<string, { info: Approval; settle: (allowed: boolean) => void }>();
  readonly events = new EventTarget();
  private changed(id: string) { this.events.dispatchEvent(new CustomEvent('change', { detail: { id } })); }
  has(sessionId: string) { return [...this.pending.values()].some(({ info }) => info.sessionId === sessionId); }
  list() { return [...this.pending.values()].map(({ info }) => ({ ...info })); }
  request(sessionId: string, runId: string | undefined, command: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const info = { id: randomUUID(), sessionId, runId, command, createdAt: new Date().toISOString() };
      const finish = (allowed: boolean) => {
        this.pending.delete(info.id); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.changed(sessionId);
        if (allowed) resolve(); else reject(new Error(signal?.aborted ? 'Operation cancelled' : 'Shell operation denied or approval expired'));
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), 5 * 60 * 1000); timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(info.id, { info, settle: finish });
      this.changed(sessionId);
    });
  }
  decide(id: string, allowed: boolean) {
    const request = this.pending.get(id);
    if (!request) throw new Error('Approval is no longer pending');
    request.settle(allowed);
  }
  close() { for (const request of this.pending.values()) request.settle(false); }
}
