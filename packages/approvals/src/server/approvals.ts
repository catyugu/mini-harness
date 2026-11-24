import { randomUUID } from 'node:crypto';
import type { Approval } from '../shared/request.js';
import { ToolApprovalDenied } from '@mini-harness/tools/api';
import type { ContributionSource } from '@mini-harness/kernel/contributions';
import type { RunPort } from '@mini-harness/runs/api';
import type { SessionStore } from '@mini-harness/sessions/store';
import { bindApproval, type ApprovalOptions, type ApprovalAccess } from './api.js';
type Decision = 'allow' | 'automatic' | 'deny' | 'expired' | 'cancelled';

export class Approvals {
  private pending = new Map<string, { info: Approval; automatic: boolean; settle: (decision: Decision) => void }>();
  private readonly denials = new Map<string, Set<string>>();
  readonly events = new EventTarget();
  constructor(private readonly runs: RunPort, private readonly sessions: SessionStore) {}
  private changed(id: string) { this.events.dispatchEvent(new CustomEvent('change', { detail: { id } })); }
  has(sessionId: string) { return [...this.pending.values()].some(({ info }) => info.sessionId === sessionId); }
  list() { return [...this.pending.values()].map(({ info }) => ({ ...info })); }
  [bindApproval](source: ContributionSource): ApprovalAccess {
    return { request: (id, options) => source.run('approval', (signal) => {
      if (!source.visible(id)) throw new Error('Conversation outside plugin scope');
      this.sessions.assertAvailable(id);
      if (!this.sessions.get(id)) throw new Error('Conversation not found');
      if (typeof options.title !== 'string' || !options.title.trim() || options.title.length > 200 ||
          typeof options.message !== 'string' || !options.message.trim() || options.message.length > 16000)
        throw new Error('Invalid approval request');
      const runId = this.runs.active(id) ? this.runs.info(id)?.id : undefined;
      return this.request(id, runId, source, options, this.runs.signal(id, signal) ?? signal);
    }, options.signal) };
  }
  private request(sessionId: string, runId: string | undefined, source: ContributionSource, options: ApprovalOptions, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const { title, message, context, allowFullAccess } = options;
    const key = context === undefined ? undefined : JSON.stringify([source.instanceId, sessionId, context, title, message]);
    if (runId && key && this.denials.get(runId)?.has(key)) return Promise.reject(new ToolApprovalDenied('Operation denied'));
    return new Promise<boolean>((resolve, reject) => {
      const info = { id: randomUUID(), sessionId, runId, pluginId: source.pluginId, title, message, createdAt: new Date().toISOString() };
      const finish = (decision: Decision) => {
        this.pending.delete(info.id); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.changed(sessionId);
        if (decision === 'allow' || decision === 'automatic') resolve(decision === 'automatic');
        else if (decision === 'deny') {
          if (runId && key) {
            const previous = this.denials.get(runId) ?? new Set();
            previous.add(key);
            this.denials.set(runId, previous);
          }
          reject(new ToolApprovalDenied('Operation denied'));
        } else reject(new Error(decision === 'expired' ? 'Approval expired' : 'Operation cancelled'));
      };
      const abort = () => finish('cancelled');
      const timer = setTimeout(() => finish('expired'), 5 * 60 * 1000); timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(info.id, { info, automatic: allowFullAccess === true, settle: finish });
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
    for (const { info, automatic, settle } of [...this.pending.values()])
      if (automatic && info.sessionId === sessionId) settle('automatic');
  }
  finishRun(runId: string) {
    for (const { info, settle } of [...this.pending.values()])
      if (info.runId === runId) settle('cancelled');
    this.denials.delete(runId);
  }
  cancelSessions(ids: string[]) {
    const selected = new Set(ids);
    for (const { info, settle } of [...this.pending.values()])
      if (selected.has(info.sessionId)) settle('cancelled');
  }
  close() {
    for (const request of this.pending.values()) request.settle('cancelled');
    this.denials.clear();
  }
}
