import type { ThinkingLevel } from '@mini-harness/contracts/agent';
import type { ScopePort } from '@mini-harness/contracts/capabilities';
import { DomainError } from '@mini-harness/platform/errors';
import { type MutationPort } from '@mini-harness/contracts/routes';
import { randomUUID } from 'node:crypto';
import { imageMimeType, prepareInput, validateModelOptions } from '@mini-harness/contracts/input-node';
import type { Attachment, InputSource } from '@mini-harness/contracts/input';
import type { CapabilityObservation } from '@mini-harness/contracts/events';
import type { ModelChoice } from '@mini-harness/contracts/conversation';
import { RunInterrupted, type StreamEvent, type RunEvent, type RunInfo } from '@mini-harness/contracts/transport';
import { RunEvents } from './events.js';
import type { SessionStore } from '@mini-harness/contracts/session-store';


interface RunOptions {
  signal?: AbortSignal;
  source?: InputSource;
  model?: ModelChoice;
  attachments?: Attachment[];
  thinkingLevel?: ThinkingLevel | null;
  schedule?: (task: () => Promise<string>, signal: AbortSignal) => Promise<string>;
  revision?: { sourceEntryId: string; expectedLeafId: string | null };
}

interface Activity {
  controller: AbortController;
  done?: Promise<unknown>;
  events?: RunEvents;
}

export class Runs {
  readonly events = new EventTarget();
  private readonly work = new Map<string, Activity>();

  constructor(
    private readonly registry: SessionStore,
    private readonly scopes: ScopePort,
    private readonly mutations: MutationPort,
    private readonly observe: (event: CapabilityObservation, signal?: AbortSignal) => void
  ) {}

  private changed(id: string) { this.events.dispatchEvent(new CustomEvent('change', { detail: { id } })); }

  get size() { return this.work.size; }
  active(id: string) { return this.work.has(id); }
  activeInScope(scopes: ReadonlySet<string>) {
    return [...this.work.keys()].some((id) => this.scopes.address(id).some((key) => scopes.has(key)));
  }
  completion(id: string) { return this.work.get(id)?.done; }

  activity(id: string) {
    const events = this.work.get(id)?.events;
    return { partial: events?.partial, tools: events?.activeTools ?? [] };
  }

  signal(id: string, signal?: AbortSignal) {
    const owner = this.work.get(id)?.controller.signal;
    return owner && signal ? AbortSignal.any([owner, signal]) : owner ?? signal;
  }

  private launch(id: string, prompt: string, emit: ((event: StreamEvent) => void) | undefined, { signal, source, model, attachments, thinkingLevel, revision, schedule }: RunOptions) {
    this.registry.assertAvailable(id);
    this.mutations.admit(this.scopes.address(id));
    if (this.active(id)) throw new DomainError('conflict', 'Conversation is already running');
    validateModelOptions(model, thinkingLevel);
    const prepared = prepareInput(prompt, attachments);
    const record = this.registry.get(id);
    if (!record) throw new DomainError('not_found', 'Conversation not found');
    const info: RunInfo = { id: randomUUID(), sessionId: id, state: 'queued', startedAt: new Date().toISOString(), sequence: 0 };
    const events = new RunEvents(info);
    const controller = new AbortController();
    const cancellation = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const log = this.registry.log(id);
    log.append({ type: 'run', run: info });
    const publish = (event: StreamEvent) => {
      const item = events.publish(event);
      try { emit?.(item); } catch { /* An observer cannot terminate the run. */ }
    };
    const promptSession = async () => {
      cancellation.throwIfAborted();
      const running = { ...info, state: 'running' as const, sequence: info.sequence + 1 };
      log.append({ type: 'run', run: running });
      info.state = running.state;
      this.changed(id);
      publish({ type: 'run', run: running });
      this.observe({ type: 'run-started', sessionId: id, run: running }, cancellation);
      await this.scopes.prepare(id, cancellation);
      return this.agent(id).prompt(record, prepared.text, publish, {
        signal: cancellation, source, submissionId: info.id, choice: model, images: prepared.images, input: prepared.input, thinkingLevel, revision,
        changed: (path) => { info.changedFiles = [...new Set([...(info.changedFiles ?? []), path])]; }
      });
    };
    const activity: Activity = { controller, events };
    this.work.set(id, activity);
    this.changed(id);
    const finish = (state: RunInfo['state'], error?: string) => {
      for (const item of log.inbox()) {
        if (item.mode === 'steer') log.append({ type: 'inbox-failed', inboxId: item.id,
          reason: state === 'interrupted' ? 'The target run was interrupted before delivery' : 'The target run ended before delivery' });
      }
      const terminal = { ...info, state, error, finishedAt: new Date().toISOString(), sequence: info.sequence + 1 };
      log.append({ type: 'run', run: terminal });
      Object.assign(info, terminal, { sequence: info.sequence });
      publish({ type: 'run', run: terminal });
      this.observe({ type: 'run-ended', sessionId: id, run: terminal });
    };
    const done = Promise.resolve().then(() => schedule ? schedule(promptSession, cancellation) : promptSession()).then((text) => {
      finish('completed');
      return text;
    }, (error) => {
      const state = cancellation.reason instanceof RunInterrupted ? 'interrupted' : cancellation.aborted ? 'cancelled' : 'failed';
      const reason = cancellation.aborted ? cancellation.reason?.message ?? 'Agent run cancelled' :
        error instanceof Error ? error.message : String(error);
      if (this.registry.logError(id)) throw error;
      if (state === 'failed') publish({ type: 'error', error: reason });
      finish(state, reason);
      throw new Error(reason, { cause: error });
    }).catch((error) => {
      const fault = this.registry.logError(id);
      if (fault) publish({ type: 'error', error: fault });
      throw error;
    }).finally(() => {
      this.work.delete(id);
      events.close();
      this.changed(id);
    });
    // Server-owned runs may outlive every observer.
    activity.done = done;
    void done.catch(() => {});
    return { info, done };
  }

  async send(id: string, prompt: string, emit?: (event: StreamEvent) => void, options: RunOptions = {}) {
    return this.launch(id, prompt, emit, options).done;
  }

  startRun(id: string, prompt: string, { model, attachments, thinkingLevel }: Pick<RunOptions, 'model' | 'attachments' | 'thinkingLevel'> = {}) {
    return { ...this.launch(id, prompt, undefined, { model, attachments, thinkingLevel }).info };
  }

  /** A run reservation protects branch navigation from concurrent submissions. */
  async reviseAndStart(id: string, input: { sourceEntryId: string; expectedLeafId: string | null; message: string; removedImages?: number[];
    attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: ThinkingLevel | null }) {
    if (this.active(id)) throw new DomainError('conflict', 'Conversation is already running');
    this.mutations.admit(this.scopes.address(id));
    await this.scopes.prepare(id);
    const target = await this.agent(id).revisionTarget(id, input.sourceEntryId, input.expectedLeafId);
    const removed = input.removedImages ?? [];
    if (!Array.isArray(removed) || removed.some((index) => !Number.isInteger(index) || index < 0 || index >= target.images.length))
      throw new DomainError('invalid_input', 'Invalid original image selection');
    const attached = input.attachments ?? [];
    if (!Array.isArray(attached)) throw new DomainError('invalid_input', 'Invalid attachments');
    const missing = target.textFiles.filter((name) => !attached.some((file) => file?.name === name && typeof file.mimeType === 'string' && !imageMimeType.test(file.mimeType)));
    if (missing.length) throw new DomainError('invalid_input', 'Reattach the original text files: ' + missing.join(', '));
    const attachments = [...target.images.filter((_, index) => !removed.includes(index)), ...attached];
    return this.launch(id, input.message, undefined, {
      attachments, model: input.model, thinkingLevel: input.thinkingLevel,
      revision: { sourceEntryId: input.sourceEntryId, expectedLeafId: input.expectedLeafId }
    }).info;
  }

  info(id: string): RunInfo | undefined {
    const info = this.work.get(id)?.events?.info ?? this.registry.runSummary(id);
    return info && structuredClone(info);
  }

  watch(id: string, runId: string, after: number, emit: (event: RunEvent) => void, end?: () => void) {
    const events = this.work.get(id)?.events;
    const info = this.info(id);
    if (!info || info.id !== runId) throw new DomainError('not_found', 'Run not found');
    // A restarted run has no volatile delta cursor; its durable interrupted snapshot is authoritative.
    if (!Number.isSafeInteger(after) || after < 0 || (after > info.sequence && info.state !== 'interrupted'))
      throw new DomainError('invalid_input', 'Invalid event cursor');
    if (events) return events.watch(after, emit, () => this.agent(id).messages(id), end);
    emit({ type: 'snapshot', messages: this.agent(id).messages(id), tools: [], run: info, sequence: info.sequence, runId: info.id, runSessionId: id });
    return () => {};
  }

  cancel(id: string) {
    let cancelled = false;
    for (const child of this.registry.descendants([id])) {
      const activity = this.work.get(child);
      if (!activity) continue;
      cancelled = true;
      activity.controller.abort(new Error(activity.events ? 'Agent run cancelled' : 'Compaction cancelled'));
    }
    return cancelled;
  }

  async compact(id: string) {
    this.registry.assertAvailable(id);
    this.mutations.admit(this.scopes.address(id));
    if (this.active(id)) throw new DomainError('conflict', 'Stop the open conversation before compacting it');
    const controller = new AbortController();
    const done = this.scopes.prepare(id, controller.signal).then(() => this.agent(id).compact(id, controller.signal));
    this.work.set(id, { done, controller });
    try { await done; }
    finally { this.work.delete(id); }
  }

  private agent(id: string) { return this.scopes.require(id, 'harnessAgent'); }

  async stop() {
    const active = [...this.work.values()];
    for (const { controller } of active) controller.abort(new RunInterrupted());
    await Promise.allSettled(active.map(({ done }) => done));
  }
}
