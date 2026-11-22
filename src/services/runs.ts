import { randomUUID } from 'node:crypto';
import { prepareInput, type Attachment } from '../input.js';
import { RunEvents } from './run-events.js';
import type { PiSessions, ThinkingLevel } from '../adapters/pi/sessions.js';
import type { Conversation, SessionRegistry, ModelChoice } from './conversations.js';
import type { StreamEvent, RunEvent, RunInfo } from '../protocol.js';

interface RunOptions {
  signal?: AbortSignal;
  model?: ModelChoice;
  attachments?: Attachment[];
  thinkingLevel?: ThinkingLevel;
  revision?: { sourceEntryId: string; expectedLeafId: string | null };
}

interface Activity {
  controller: AbortController;
  done?: Promise<unknown>;
  events?: RunEvents;
}

export class Runs {
  private readonly work = new Map<string, Activity>();

  constructor(
    private readonly registry: SessionRegistry,
    private readonly pi: PiSessions,
    private readonly defaultModel: () => ModelChoice,
    private readonly assertAvailable: (id: string) => void,
    private readonly schedule: (record: Conversation, task: () => Promise<string>, signal: AbortSignal) => Promise<string>
  ) {}

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

  private launch(id: string, prompt: string, emit: (event: StreamEvent) => void, { signal, model, attachments, thinkingLevel, revision }: RunOptions) {
    this.assertAvailable(id);
    if (this.active(id)) throw new Error('Conversation is already running');
    if (thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinkingLevel))
      throw new Error('Invalid thinking level');
    const prepared = prepareInput(prompt, attachments);
    const record = this.registry.get(id);
    if (!record) throw new Error('Conversation not found');
    if (model !== undefined) {
      if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string' ||
          model.provider.length > 160 || model.id.length > 160) throw new Error('Invalid model choice');
      this.pi.resolveModel(model);
    }
    const choice = model ?? (record.parentId ? record.model : this.defaultModel());
    this.pi.reopenStale(id);
    const info: RunInfo = { id: randomUUID(), sessionId: id, state: 'queued', startedAt: new Date().toISOString(), sequence: 0 };
    const events = new RunEvents(info);
    const controller = new AbortController();
    const cancellation = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    this.registry.update(id, { run: { ...info } });
    const publish = (event: StreamEvent) => {
      const item = events.publish(event);
      try { emit?.(item); } catch { /* An observer cannot terminate the run. */ }
    };
    const promptSession = async () => {
      cancellation.throwIfAborted();
      info.state = 'running';
      const running = { ...info, sequence: info.sequence + 1 };
      this.registry.update(id, { run: running });
      publish({ type: 'run', run: running });
      return this.pi.prompt(record, prepared.text, publish, {
        signal: cancellation, choice, images: prepared.images, thinkingLevel, revision,
        changed: (path) => { info.changedFiles = [...new Set([...(info.changedFiles ?? []), path])]; }
      });
    };
    const activity: Activity = { controller, events };
    this.work.set(id, activity);
    const done = this.schedule(record, promptSession, cancellation).then((text) => {
      info.state = 'completed';
      return text;
    }, (error) => {
      info.state = cancellation.aborted ? 'cancelled' : 'failed';
      info.error = cancellation.aborted ? 'Agent run cancelled' : error instanceof Error ? error.message : String(error);
      publish({ type: 'error', error: info.error });
      throw new Error(info.error, { cause: error });
    }).finally(() => {
      info.finishedAt = new Date().toISOString();
      publish({ type: 'run', run: { ...info, sequence: info.sequence + 1 } });
      try { this.registry.update(id, { run: { ...info } }); }
      finally { this.work.delete(id); events.close(); }
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

  /** A run reservation protects Pi branch navigation from concurrent submissions. */
  async reviseAndStart(id: string, input: { sourceEntryId: string; expectedLeafId: string | null; message: string;
    attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: ThinkingLevel }) {
    if (this.active(id)) throw new Error('Conversation is already running');
    await this.pi.revisionTarget(id, input.sourceEntryId, input.expectedLeafId);
    return this.launch(id, input.message, undefined, {
      attachments: input.attachments, model: input.model, thinkingLevel: input.thinkingLevel,
      revision: { sourceEntryId: input.sourceEntryId, expectedLeafId: input.expectedLeafId }
    }).info;
  }

  info(id: string): RunInfo | undefined {
    const info = this.work.get(id)?.events?.info ?? this.registry.get(id)?.run;
    return info && { ...info };
  }

  watch(id: string, runId: string, after: number, emit: (event: RunEvent) => void) {
    const events = this.work.get(id)?.events;
    const info = this.info(id);
    if (!info || info.id !== runId) throw new Error('Run not found');
    if (!Number.isSafeInteger(after) || after < 0 || after > info.sequence) throw new Error('Invalid event cursor');
    if (events) return events.watch(after, emit, () => this.pi.messages(id));
    emit({ type: 'snapshot', messages: this.pi.messages(id), tools: [], run: info, sequence: info.sequence });
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
    if (this.active(id)) throw new Error('Stop the open conversation before compacting it');
    const controller = new AbortController();
    const done = this.pi.compact(id, controller.signal);
    this.work.set(id, { done, controller });
    try { await done; }
    finally { this.work.delete(id); }
  }

  async stop() {
    const active = [...this.work.values()];
    for (const { controller } of active) controller.abort();
    await Promise.allSettled(active.map(({ done }) => done));
  }
}
