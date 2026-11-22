import { randomUUID } from 'node:crypto';
export interface Approval { id: string; sessionId: string; command: string; createdAt: string }
export class Approvals {
  private pending = new Map<string, { info: Approval; settle: (allowed: boolean) => void }>();
  list() { return [...this.pending.values()].map(({ info }) => ({ ...info })); }
  request(sessionId: string, command: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const info = { id: randomUUID(), sessionId, command, createdAt: new Date().toISOString() };
      const finish = (allowed: boolean) => {
        this.pending.delete(info.id); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (allowed) resolve(); else reject(new Error(signal?.aborted ? 'Operation cancelled' : 'Shell operation denied or approval expired'));
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), 5 * 60 * 1000); timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(info.id, { info, settle: finish });
    });
  }
  decide(id: string, allowed: boolean) {
    const request = this.pending.get(id);
    if (!request) throw new Error('Approval is no longer pending');
    request.settle(allowed);
  }
  close() { for (const request of this.pending.values()) request.settle(false); }
}
