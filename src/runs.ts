import { randomUUID } from 'node:crypto';
import { prepareInput, type Attachment } from './input.js';
import { RunEvents } from './run-events.js';
import type { PiSessions, ThinkingLevel } from './pi-sessions.js';
import type { Conversation, SessionRegistry, ModelChoice } from './registry.js';
import type { StreamEvent, RunEvent, RunInfo } from './protocol.js';

interface RunOptions {
  signal?: AbortSignal;
  model?: ModelChoice;
  attachments?: Attachment[];
  thinkingLevel?: ThinkingLevel;
}

interface ActiveRun {
  info: RunInfo;
  controller: AbortController;
  events: RunEvents;
  done?: Promise<string>;
}

export class Runs {
  private readonly busy = new Map<string, ActiveRun>();
  private readonly compactions = new Map<string, { done: Promise<void>; controller: AbortController }>();

  constructor(
    private readonly registry: SessionRegistry,
    private readonly pi: PiSessions,
    private readonly defaultModel: () => ModelChoice,
    private readonly assertAvailable: (id: string) => void,
    private readonly schedule: (record: Conversation, task: () => Promise<string>, signal: AbortSignal) => Promise<string>
  ) {}

  get size() { return this.busy.size; }
  get hasWork() { return Boolean(this.busy.size || this.compactions.size); }
  active(id: string) { return this.busy.has(id) || this.compactions.has(id); }
  completion(id: string) { return this.busy.get(id)?.done ?? this.compactions.get(id)?.done; }

  view(id: string) {
    const run = this.busy.get(id);
    return { run: this.info(id), partial: run?.events.partial, tools: run?.events.activeTools ?? [], busy: Boolean(run) };
  }

  signal(id: string, signal?: AbortSignal) {
    const owner = this.busy.get(id)?.controller.signal;
    return owner && signal ? AbortSignal.any([owner, signal]) : owner ?? signal;
  }

  private launch(id: string, prompt: string, emit: (event: StreamEvent) => void, { signal, model, attachments, thinkingLevel }: RunOptions) {
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
    const run: ActiveRun = { info, controller: new AbortController(), events: new RunEvents(info) };
    const cancellation = signal ? AbortSignal.any([run.controller.signal, signal]) : run.controller.signal;
    this.registry.update(id, { run: { ...run.info } });
    this.busy.set(id, run);
    const publish = (event: StreamEvent) => {
      const item = run.events.publish(event);
      try { emit?.(item); } catch { /* An observer cannot terminate the run. */ }
    };
    const promptSession = async () => {
      cancellation.throwIfAborted();
      run.info.state = 'running';
      const running = { ...run.info, sequence: run.info.sequence + 1 };
      this.registry.update(id, { run: running });
      publish({ type: 'run', run: running });
      return this.pi.prompt(record, prepared.text, publish, cancellation, choice, prepared.images, thinkingLevel, (path) => {
        run.info.changedFiles = [...new Set([...(run.info.changedFiles ?? []), path])];
      });
    };
    const work = this.schedule(record, promptSession, cancellation);
    run.done = work.then((text) => {
      run.info.state = 'completed';
      return text;
    }, (error) => {
      run.info.state = cancellation.aborted ? 'cancelled' : 'failed';
      run.info.error = cancellation.aborted ? 'Agent run cancelled' : error instanceof Error ? error.message : String(error);
      publish({ type: 'error', error: run.info.error });
      throw new Error(run.info.error, { cause: error });
    }).finally(() => {
      run.info.finishedAt = new Date().toISOString();
      publish({ type: 'run', run: { ...run.info, sequence: run.info.sequence + 1 } });
      try { this.registry.update(id, { run: { ...run.info } }); }
      finally { this.busy.delete(id); run.events.close(); }
    });
    // Server-owned runs may outlive every observer.
    void run.done.catch(() => {});
    return run;
  }

  async send(id: string, prompt: string, emit?: (event: StreamEvent) => void, options: RunOptions = {}) {
    return this.launch(id, prompt, emit, options).done;
  }

  startRun(id: string, prompt: string, model?: ModelChoice, attachments?: Attachment[], thinkingLevel?: ThinkingLevel) {
    return { ...this.launch(id, prompt, undefined, { model, attachments, thinkingLevel }).info };
  }

  info(id: string): RunInfo | undefined {
    const info = this.busy.get(id)?.info ?? this.registry.get(id)?.run;
    return info && { ...info };
  }

  watch(id: string, runId: string, after: number, emit: (event: RunEvent) => void) {
    const run = this.busy.get(id);
    const info = this.info(id);
    if (!info || info.id !== runId) throw new Error('Run not found');
    if (!Number.isSafeInteger(after) || after < 0 || after > info.sequence) throw new Error('Invalid event cursor');
    if (run) return run.events.watch(after, emit, () => this.pi.messages(id));
    emit({ type: 'snapshot', messages: this.pi.messages(id), tools: [], run: info, sequence: info.sequence });
    return () => {};
  }

  cancel(id: string) {
    let cancelled = false;
    for (const child of this.registry.descendants([id])) {
      const run = this.busy.get(child);
      if (run) { cancelled = true; run.controller.abort(new Error('Agent run cancelled')); }
      const compaction = this.compactions.get(child);
      if (compaction) { cancelled = true; compaction.controller.abort(new Error('Compaction cancelled')); }
    }
    return cancelled;
  }

  async compact(id: string) {
    if (this.active(id)) throw new Error('Stop the open conversation before compacting it');
    const controller = new AbortController();
    const done = this.pi.compact(id, controller.signal);
    this.compactions.set(id, { done, controller });
    try { await done; }
    finally { this.compactions.delete(id); }
  }

  async queueInput(id: string, text: string, mode: 'steer' | 'followUp', attachments?: Attachment[]) {
    if (!this.busy.has(id)) throw new Error('The agent is not streaming; send a new message');
    return this.pi.queueInput(id, text, mode, attachments);
  }

  async stop() {
    const ids = [...this.busy.keys(), ...this.compactions.keys()];
    for (const id of ids) this.cancel(id);
    await Promise.allSettled(ids.map((id) => this.completion(id)));
  }
}
