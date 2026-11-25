import { randomUUID } from 'node:crypto';
import type { ApprovalPrompt } from './api.ts';
import type { Approval } from '../shared/request.ts';
import { ApprovalDenied } from './api.ts';
type Decision = 'allow' | 'automatic' | 'deny' | 'expired' | 'cancelled';

export class Approvals {
  private pending = new Map<
    string,
    { info: Approval; followFullAccess: boolean; settle: (decision: Decision) => void }
  >();
  private readonly denials = new Map<string, Set<string>>();
  readonly events = new EventTarget();
  private changed(id: string) {
    this.events.dispatchEvent(new CustomEvent('change', { detail: { id } }));
  }
  has(sessionId: string) {
    return [...this.pending.values()].some(({ info }) => info.sessionId === sessionId);
  }
  list() {
    return [...this.pending.values()].map(({ info }) => ({ ...info }));
  }
  request(
    sessionId: string,
    runId: string | undefined,
    plugin: string,
    prompt: ApprovalPrompt,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const { title, message, context, followFullAccess = false } = prompt;
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 140 ||
      typeof message !== 'string' ||
      !message.trim() ||
      message.length > 16000
    )
      throw new Error('Invalid approval prompt');
    const key = context === undefined ? undefined : JSON.stringify([sessionId, plugin, context, message]);
    if (runId && key && this.denials.get(runId)?.has(key))
      return Promise.reject(new ApprovalDenied('Operation denied by user'));
    return new Promise<boolean>((resolve, reject) => {
      const info = {
        id: randomUUID(),
        sessionId,
        runId,
        plugin,
        title,
        message,
        createdAt: new Date().toISOString(),
      };
      const finish = (decision: Decision) => {
        this.pending.delete(info.id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.changed(sessionId);
        if (decision === 'allow' || decision === 'automatic') resolve(decision === 'automatic');
        else if (decision === 'deny') {
          if (runId && key) {
            const previous = this.denials.get(runId) ?? new Set();
            previous.add(key);
            this.denials.set(runId, previous);
          }
          reject(new ApprovalDenied('Operation denied by user'));
        } else reject(new Error(decision === 'expired' ? 'User approval expired' : 'Operation cancelled'));
      };
      const abort = () => finish('cancelled');
      const timer = setTimeout(() => finish('expired'), 5 * 60 * 1000);
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(info.id, { info, followFullAccess, settle: finish });
      this.changed(sessionId);
    });
  }
  decide(id: string, allowed: boolean) {
    const request = this.pending.get(id);
    if (!request) throw new Error('Approval is no longer pending');
    request.settle(allowed ? 'allow' : 'deny');
  }
  /** An explicit Full access selection releases this conversation's pending approvals. */
  approveSession(sessionId: string) {
    for (const { info, settle, followFullAccess } of [...this.pending.values()])
      if (info.sessionId === sessionId && followFullAccess) settle('automatic');
  }
  finishRun(runId: string) {
    this.denials.delete(runId);
    for (const { info, settle } of this.pending.values()) if (info.runId === runId) settle('cancelled');
  }
  cancelSession(id: string) {
    for (const { info, settle } of this.pending.values()) if (info.sessionId === id) settle('cancelled');
  }
  close() {
    for (const request of this.pending.values()) request.settle('cancelled');
    this.denials.clear();
  }
}
