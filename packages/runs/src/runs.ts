import type {} from '@mini-harness/agent/api';
import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ScopeKey, ScopePort } from '@mini-harness/kernel/scopes';
import { DomainError } from '@mini-harness/platform/errors';
import type { MutationPort } from '@mini-harness/kernel/mutation-api';
import { randomUUID } from 'node:crypto';
import { imageMimeType, prepareInput } from '@mini-harness/input/prepare';
import { validateModelOptions } from '@mini-harness/llm/options';
import type { Attachment, InputSource } from '@mini-harness/input/message';
import type { CapabilityObservation } from '@mini-harness/kernel/observations';
import { RunInterrupted } from '@mini-harness/agent/stream';
import type { StreamEvent, RunEvent } from './stream.js';
import { isRunning, type RunInfo } from '@mini-harness/sessions/run-state';
import { RunEvents } from './events.js';
import type { ModelPreference } from '@mini-harness/models/api';
import type { ExecutionInput } from './execution.js';
import type { RunPort } from './api.js';
import type { SessionStore } from '@mini-harness/sessions/store';

interface RunOptions {
  signal?: AbortSignal;
  source?: InputSource;
  model?: ModelChoice;
  attachments?: Attachment[];
  thinkingLevel?: ThinkingLevel | null;
  acquire?: (signal: AbortSignal) => Promise<() => void>;
  revision?: { parentId: string | null; expectedLeafId: string | null };
}

interface Activity {
  controller: AbortController;
  done?: Promise<unknown>;
  events?: RunEvents;
  inputSignal?: AbortSignal;
}

export class Runs implements RunPort {
  readonly events = new EventTarget();
  private readonly work = new Map<string, Activity>();

  constructor(
    private readonly registry: SessionStore,
    private readonly scopes: ScopePort,
    private readonly mutations: MutationPort,
    private readonly observe: (event: CapabilityObservation, signal?: AbortSignal) => void,
    private readonly preference: ModelPreference
  ) {}

  private changed(id: string) { this.events.dispatchEvent(new CustomEvent('change', { detail: { id } })); }

  get size() { return this.work.size; }
  active(id: string) { return this.work.has(id); }
  activeInScope(scopes: ReadonlySet<ScopeKey>) {
    return [...this.work.keys()].some((id) => this.scopes.address(`session:${id}`).some((key) => scopes.has(key)));
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

  branchChanged(id: string) {
    const events = this.work.get(id)?.events;
    if (!events || !isRunning(events.info)) return;
    const { records, leafId } = this.registry.log(id).projection();
    events.publish({ type: 'branch', records, leafId });
  }

  private reserve(id: string): Activity {
    this.registry.assertAvailable(id);
    this.mutations.admit(this.scopes.address(`session:${id}`));
    if (this.active(id)) throw new DomainError('conflict', 'Conversation is already running');
    const activity: Activity = { controller: new AbortController() };
    this.work.set(id, activity);
    return activity;
  }

  private launch(id: string, prompt: string, emit: ((event: StreamEvent) => void) | undefined,
    { signal, source, model, attachments, thinkingLevel, revision, acquire }: RunOptions, preparedScope?: Activity) {
    validateModelOptions(model, thinkingLevel);
    const fallback = this.preference.recent();
    const prepared = prepareInput(prompt, attachments);
    const record = this.registry.get(id);
    if (!record) throw new DomainError('not_found', 'Conversation not found');
    signal?.throwIfAborted();
    const activity = preparedScope ?? this.reserve(id);
    const { controller } = activity;
    const cancellation = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const info: RunInfo = { id: randomUUID(), sessionId: id, state: 'queued', startedAt: new Date().toISOString(), sequence: 0, inputEntryId: null };
    const events = activity.events = new RunEvents(info);
    let log: ReturnType<SessionStore['log']>;
    try {
      cancellation.throwIfAborted();
      log = this.registry.log(id);
      log.append({ type: 'run', run: info });
    } catch (error) { this.work.delete(id); throw error; }
    const publish = (event: StreamEvent) => {
      if (event.type === 'user') info.inputEntryId = event.id;
      const item = events.publish(event);
      try { emit?.(item); } catch { /* An observer cannot terminate the run. */ }
      if (event.type === 'user') {
        this.observe({ type: 'input-accepted', sessionId: id, parentId: record.parentId,
          source: event.source, runSource: source ?? 'user', model: event.model });
      }
    };
    const promptSession = async () => {
      cancellation.throwIfAborted();
      const running = { ...info, state: 'running' as const, sequence: info.sequence + 1 };
      log.append({ type: 'run', run: running });
      info.state = running.state;
      this.changed(id);
      publish({ type: 'run', run: running });
      this.observe({ type: 'run-started', sessionId: id, run: running }, cancellation);
      if (!preparedScope) await this.scopes.prepare(`session:${id}`, cancellation);
      cancellation.throwIfAborted();
      activity.inputSignal = cancellation;
      try {
        return await this.agent(id).prompt(record, prepared.text, publish, {
          fallback, beginSubmission: () => { info.inputEntryId = null; },
          signal: cancellation, source, submissionId: info.id, choice: model, images: prepared.images, input: prepared.input, thinkingLevel, revision,
          changed: (path) => { info.changedFiles = [...new Set([...(info.changedFiles ?? []), path])]; }
        });
      } finally { activity.inputSignal = undefined; }
    };
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
    const done = Promise.resolve().then(async () => {
      const release = await acquire?.(cancellation);
      try { return await promptSession(); }
      finally { release?.(); }
    }).then((text) => {
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
    this.changed(id);
    void done.catch(() => {});
    return { info, done, cancel: () => {
      if (this.work.get(id) !== activity || cancellation.aborted) return false;
      controller.abort(new Error('Agent run cancelled'));
      return true;
    } };
  }

  submit(id: string, { message, model, attachments, thinkingLevel }: ExecutionInput,
    signal: AbortSignal, acquire?: RunOptions['acquire']) {
    const { info, done, cancel } = this.launch(id, message, undefined, { model, attachments, thinkingLevel, source: 'plugin', signal, acquire });
    return { id: info.id, result: done, cancel };
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
    const reservation = this.reserve(id);
    const { signal } = reservation.controller;
    const prepare = this.scopes.prepare(`session:${id}`, signal);
    reservation.done = prepare;
    try {
      await prepare;
      const target = this.agent(id).revisionTarget(id, input.sourceEntryId, input.expectedLeafId);
      const removed = input.removedImages ?? [];
      if (!Array.isArray(removed) || removed.some((index) => !Number.isInteger(index) || index < 0 || index >= target.images.length))
        throw new DomainError('invalid_input', 'Invalid original image selection');
      const attached = input.attachments ?? [];
      if (!Array.isArray(attached)) throw new DomainError('invalid_input', 'Invalid attachments');
      const missing = target.textFiles.filter((name) => !attached.some((file) => file?.name === name && typeof file.mimeType === 'string' && !imageMimeType.test(file.mimeType)));
      if (missing.length) throw new DomainError('invalid_input', 'Reattach the original text files: ' + missing.join(', '));
      const attachments = [...target.images.filter((_, index) => !removed.includes(index)), ...attached];
      return { ...this.launch(id, input.message, undefined, {
        attachments, model: input.model, thinkingLevel: input.thinkingLevel,
        revision: { parentId: target.parentId, expectedLeafId: input.expectedLeafId }
      }, reservation).info };
    } catch (error) { this.work.delete(id); throw error; }
  }

  retryInput(id: string, runId: string) {
    const run = this.info(id);
    if (run?.id !== runId || run.state !== 'failed') throw new DomainError('conflict', 'This run is no longer the failed conversation run');
    return this.registry.inspectLog(id, (log) => {
      const entries = log.entries();
      const start = entries.findIndex((entry) => entry.type === 'run' && entry.run.id === runId && entry.run.state === 'queued');
      const end = entries.findIndex((entry, index) => index > start && entry.type === 'run' && entry.run.id === runId && entry.run.state === 'failed');
      if (start < 0 || end < 0) return;
      const delivered = entries.slice(start + 1, end).filter((entry) => entry.type === 'message' && entry.message.role === 'user');
      const input = run.inputEntryId === undefined
        ? delivered.length === 1 && delivered[0].type === 'message' && delivered[0].submissionId === runId ? delivered[0] : undefined
        : delivered.find(({ id }) => id === run.inputEntryId);
      if (input?.type !== 'message' || input.message.role !== 'user') return;
      const { message, presentation, selection } = input;
      const parts = typeof message.content === 'string' ? [] : message.content;
      const images = [...presentation?.images ?? parts.filter((part) => part.type === 'image')];
      const attachments: Attachment[] = [], missing: string[] = [];
      for (const { name, mimeType } of presentation?.attachments ?? []) {
        const image = imageMimeType.test(mimeType) ? images.shift() : undefined;
        if (image) attachments.push({ name, mimeType, data: image.data });
        else missing.push(name);
      }
      if (images.length) missing.push('the original images');
      const text = typeof message.content === 'string' ? message.content : parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
      return { message: presentation?.userText ?? text, attachments, missing, model: selection?.model, thinkingLevel: selection?.thinkingLevel };
    });
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
    const history = () => {
      const projection = this.registry.inspectLog(id, (log) => log.projection(), true);
      return { messages: projection?.messages ?? [], records: projection?.records ?? [], leafId: projection?.leafId ?? null,
        model: projection?.model, thinkingLevel: projection?.thinkingLevel };
    };
    if (events) return events.watch(after, emit, history, end);
    emit({ type: 'snapshot', ...history(), tools: [], run: info, sequence: info.sequence, runId: info.id, runSessionId: id });
    return () => {};
  }

  queueInput(id: string, { message, mode, attachments, model, thinkingLevel }: Parameters<RunPort['queueInput']>[1]) {
    this.mutations.admit(this.scopes.address(`session:${id}`));
    const signal = this.work.get(id)?.inputSignal;
    if (!signal || signal.aborted)
      throw new DomainError('conflict', 'The agent is not streaming; send a new message');
    return this.agent(id).queueInput(id, message, mode, attachments,
      { model, thinkingLevel, fallback: this.preference.recent() });
  }

  async cancelQueue(id: string, itemId?: string, signal?: AbortSignal) {
    const key = `session:${id}` as const;
    if (!this.work.get(id)?.inputSignal) await this.scopes.prepare(key, signal);
    this.mutations.admit(this.scopes.address(key));
    return this.agent(id).cancelQueue(id, itemId);
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
    const activity = this.reserve(id);
    const { signal } = activity.controller;
    const done = activity.done = this.scopes.prepare(`session:${id}`, signal).then(() => this.agent(id).compact(id, signal));
    try { await done; }
    finally { this.work.delete(id); }
  }

  private agent(id: string) { return this.scopes.require(`session:${id}`, 'harnessAgent'); }

  async stop() {
    const active = [...this.work.values()];
    for (const { controller } of active) controller.abort(new RunInterrupted());
    await Promise.allSettled(active.map(({ done }) => done));
  }
}
