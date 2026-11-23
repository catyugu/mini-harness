import { randomUUID } from 'node:crypto';
import { prepareInput } from '@mini-harness/platform/input';
import type { Attachment } from '@mini-harness/contracts/input';
import type { CapabilityObservation } from '@mini-harness/contracts/events';
import type { RunAgentPort, ThinkingLevel } from '@mini-harness/contracts/agent';
import type { ModelChoice } from '@mini-harness/contracts/conversation';
import type { StreamEvent, RunEvent, RunInfo } from '@mini-harness/contracts/transport';
import { RunEvents } from './events.js';
import type { SessionStore } from '@mini-harness/contracts/services';


interface RunOptions {
  signal?: AbortSignal;
  model?: ModelChoice;
  attachments?: Attachment[];
  thinkingLevel?: ThinkingLevel;
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
    private readonly agent: RunAgentPort,
    private readonly observe: (event: CapabilityObservation) => void
  ) {}

  private changed(id: string) { this.events.dispatchEvent(new CustomEvent('change', { detail: { id } })); }

  get size() { return this.work.size; }
  active(id: string) { return this.work.has(id); }
  completion(id: string) { return this.work.get(id)?.done; }

  view(id: string) {
    const events = this.work.get(id)?.events;
    return { run: this.info(id), partial: events?.partial, tools: events?.activeTools ?? [] };
  }

  signal(id: string, signal?: AbortSignal) {
    const owner = this.work.get(id)?.controller.signal;
    return owner && signal ? AbortSignal.any([owner, signal]) : owner ?? signal;
  }

  private launch(id: string, prompt: string, emit: (event: StreamEvent) => void, { signal, model, attachments, thinkingLevel, revision, schedule }: RunOptions) {
    this.registry.assertAvailable(id);
    if (this.active(id)) throw new Error('Conversation is already running');
    if (thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel))
      throw new Error('Invalid thinking level');
    const prepared = prepareInput(prompt, attachments);
    const record = this.registry.get(id);
    if (!record) throw new Error('Conversation not found');
    if (model !== undefined) {
      if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string' ||
          model.provider.length > 160 || model.id.length > 160) throw new Error('Invalid model choice');
    }
    const info: RunInfo = { id: randomUUID(), sessionId: id, state: 'queued', startedAt: new Date().toISOString(), sequence: 0 };
    const events = new RunEvents(info);
    const controller = new AbortController();
    const cancellation = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    this.registry.log(id).append({ type: 'run', run: info });
    const publish = (event: StreamEvent) => {
      const item = events.publish(event);
      try { emit?.(item); } catch { /* An observer cannot terminate the run. */ }
    };
    const promptSession = async () => {
      cancellation.throwIfAborted();
      info.state = 'running';
      const running = { ...info, sequence: info.sequence + 1 };
      this.registry.log(id).append({ type: 'run', run: running });
      this.changed(id);
      publish({ type: 'run', run: running });
      this.observe({ type: 'run-started', sessionId: id, run: running });
      return this.agent.prompt(record, prepared.text, publish, {
        signal: cancellation, choice: model, images: prepared.images, input: prepared.input, thinkingLevel, revision,
        changed: (path) => { info.changedFiles = [...new Set([...(info.changedFiles ?? []), path])]; }
      });
    };
    const activity: Activity = { controller, events };
    this.work.set(id, activity);
    this.changed(id);
    const done = Promise.resolve().then(() => schedule ? schedule(promptSession, cancellation) : promptSession()).then((text) => {
      info.state = 'completed';
      return text;
    }, (error) => {
      info.state = cancellation.aborted ? 'cancelled' : 'failed';
      info.error = cancellation.aborted ? controller.signal.reason?.message ?? 'Agent run cancelled' :
        error instanceof Error ? error.message : String(error);
      publish({ type: 'error', error: info.error });
      throw new Error(info.error, { cause: error });
    }).finally(() => {
      info.finishedAt = new Date().toISOString();
      publish({ type: 'run', run: { ...info, sequence: info.sequence + 1 } });
      try { this.registry.log(id).append({ type: 'run', run: info }); }
      finally {
        this.work.delete(id);
        events.close();
        this.changed(id);
        this.observe({ type: 'run-ended', sessionId: id, run: info });
      }
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
  async reviseAndStart(id: string, input: { sourceEntryId: string; expectedLeafId: string | null; message: string;
    attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: ThinkingLevel }) {
    if (this.active(id)) throw new Error('Conversation is already running');
    await this.agent.revisionTarget(id, input.sourceEntryId, input.expectedLeafId);
    return this.launch(id, input.message, undefined, {
      attachments: input.attachments, model: input.model, thinkingLevel: input.thinkingLevel,
      revision: { sourceEntryId: input.sourceEntryId, expectedLeafId: input.expectedLeafId }
    }).info;
  }

  info(id: string): RunInfo | undefined {
    const info = this.work.get(id)?.events?.info ?? (this.registry.get(id) ? this.registry.log(id).projection().run : undefined);
    return info && structuredClone(info);
  }

  watch(id: string, runId: string, after: number, emit: (event: RunEvent) => void) {
    const events = this.work.get(id)?.events;
    const info = this.info(id);
    if (!info || info.id !== runId) throw new Error('Run not found');
    // A restarted run has no volatile delta cursor; its durable interrupted snapshot is authoritative.
    if (!Number.isSafeInteger(after) || after < 0 || (after > info.sequence && info.state !== 'interrupted'))
      throw new Error('Invalid event cursor');
    if (events) return events.watch(after, emit, () => this.agent.messages(id));
    emit({ type: 'snapshot', messages: this.agent.messages(id), tools: [], run: info, sequence: info.sequence, runId: info.id, runSessionId: id });
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
    if (this.active(id)) throw new Error('Stop the open conversation before compacting it');
    const controller = new AbortController();
    const done = this.agent.compact(id, controller.signal);
    this.work.set(id, { done, controller });
    try { await done; }
    finally { this.work.delete(id); }
  }

  async stop() {
    const active = [...this.work.values()];
    for (const { controller } of active) controller.abort(new Error('Agent service is shutting down'));
    await Promise.allSettled(active.map(({ done }) => done));
  }
}
