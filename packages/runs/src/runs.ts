import type { RecordAppend } from '@mini-harness/sessions/display-record';
import { userContent } from '@mini-harness/sessions/user-content';
import type { Context } from 'mini-harness/cordis';
import { tagScope, scopeTarget } from '@mini-harness/plugin-api/scopes';
import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ProfileScopes } from '@mini-harness/plugin-api/configuration';
import { DomainError } from '@mini-harness/platform/errors';
import {
  terminal,
  type TaskEvent,
  type TaskHandle,
  type TaskPort,
  type TaskSnapshot,
} from '@mini-harness/tasks/api';
import { imageMimeType } from '@mini-harness/input/prepare';
import { validateModelOptions } from '@mini-harness/llm/options';
import type { Attachment, InputSource } from '@mini-harness/input/message';
import type { CapabilityObservation } from '@mini-harness/plugin-api/observations';
import { Inbox } from './inbox.ts';
import { SessionRun } from './session-run.ts';
import type { StreamEvent, RunEvent } from './stream.ts';
import { isRunning, projectRun, type RunDetails, type RunInfo } from '@mini-harness/sessions/run-state';
import { runFromEntry } from '@mini-harness/sessions/log-api';
import { RunEvents } from './events.ts';
import type { RunInput, RunPort, RunSubmission } from './api.ts';
import type { SessionStore } from '@mini-harness/sessions/records';

interface RunOptions extends RunSubmission {
  source?: InputSource;
  model?: ModelChoice;
  attachments?: Attachment[];
  thinkingLevel?: ThinkingLevel | null;
  revision?: { parentId: string | null; expectedLeafId: string | null };
}

interface Activity {
  run?: boolean;
  task?: TaskHandle;
  events?: RunEvents;
  context?: Context;
  emit?: (event: StreamEvent) => void;
}

export class Runs implements RunPort {
  readonly events = new EventTarget();
  private closing = false;
  private readonly work = new Map<string, Activity>();

  constructor(
    private readonly registry: SessionStore,
    private readonly tasks: TaskPort,
    private readonly scopes: ProfileScopes,
    private readonly observe: (event: CapabilityObservation, signal?: AbortSignal) => void,
    private readonly recent: () => ModelChoice | undefined,
    private readonly sessionRun: SessionRun,
  ) {}

  private changed(id: string) {
    this.events.dispatchEvent(new CustomEvent('change', { detail: { id } }));
  }

  get size() {
    return this.work.size;
  }

  active(id: string) {
    return this.work.has(id);
  }

  seal() {
    this.closing = true;
  }

  private assertOpen() {
    if (this.closing) throw new DomainError('unavailable', 'Runs are closing');
  }
  completion(id: string) {
    return this.work.get(id)?.task?.result;
  }

  activity(id: string) {
    const events = this.work.get(id)?.events;
    return { partial: events?.partial, tools: events?.activeTools ?? [] };
  }

  signal(id: string, signal?: AbortSignal) {
    const owner = this.work.get(id)?.task?.signal;
    return owner && signal ? AbortSignal.any([owner, signal]) : (owner ?? signal);
  }

  branchChanged(id: string, record: RecordAppend) {
    const events = this.work.get(id)?.events;
    if (!events || !isRunning(events.info)) return;
    events.publish({ type: 'branch', ...record });
  }

  private reserve(id: string): Activity {
    this.registry.assertAvailable(id);
    this.assertOpen();
    if (this.active(id)) throw new DomainError('conflict', 'Conversation is already running');
    const activity: Activity = {};
    this.work.set(id, activity);
    return activity;
  }

  private publish(activity: Activity, event: StreamEvent) {
    const item = activity.events!.publish(event);
    try {
      activity.emit?.(item);
    } catch {
      /* An observer cannot terminate the run. */
    }
  }

  /** Contribution to the session's one durable task record, before runtime settlement. */
  taskDetails(id: string, task: TaskSnapshot): RunDetails | undefined {
    const activity = this.work.get(id);
    if (task.type !== 'agent-run' || !activity?.run) return;
    const info = activity.events?.info;
    if (!info) return { sequence: 0, inputEntryId: null };
    if (info.id !== task.id) return;
    if (terminal(task.state)) {
      const inbox = new Inbox(this.registry.log(id));
      if (task.state === 'cancelled') inbox.cancel('Run cancelled');
      else
        inbox.failPending(
          'steer',
          task.state === 'interrupted'
            ? 'The target run was interrupted before delivery'
            : 'The target run ended before delivery',
        );
    }
    return {
      inputEntryId: info.inputEntryId,
      changedFiles: info.changedFiles,
      sequence: info.sequence + 1 + Number(task.state === 'failed' && Boolean(task.error)),
    };
  }

  taskChanged({ type, task }: TaskEvent) {
    if (task.type !== 'agent-run' || !task.owner.startsWith('session:')) return;
    const id = task.owner.slice(8);
    const activity = this.work.get(id);
    if (!activity?.run) return;
    if (type === 'created') {
      if (activity.events) return;
      activity.events = new RunEvents(projectRun(id, task, { sequence: 0, inputEntryId: null }));
      return;
    }
    if (type !== 'transition') return;
    const events = activity.events;
    if (!events || events.info.id !== task.id) return;
    const info = events.info;
    const firstAdmission = !info.executedAt && task.state === 'running';
    const ended = terminal(task.state);
    try {
      if (task.state === 'failed' && task.error) this.publish(activity, { type: 'error', error: task.error });
      const next = projectRun(id, task, {
        inputEntryId: info.inputEntryId,
        changedFiles: info.changedFiles,
        sequence: info.sequence + 1,
      });
      Object.assign(info, next, { sequence: info.sequence });
      this.publish(activity, { type: 'run', run: next });
      if (firstAdmission)
        this.observe({ type: 'run-started', sessionId: id, run: next }, activity.task?.signal);
      if (ended) this.observe({ type: 'run-ended', sessionId: id, run: next });
    } finally {
      if (ended) {
        this.work.delete(id);
        events.close();
      }
      this.changed(id);
    }
  }

  private launch(
    id: string,
    prompt: string,
    emit: ((event: StreamEvent) => void) | undefined,
    { signal, source, model, attachments, thinkingLevel, revision, acquire, metadata, provider }: RunOptions,
    reserved?: Activity,
  ) {
    const activity = reserved ?? this.reserve(id);
    activity.run = true;
    activity.emit = emit;
    try {
      validateModelOptions(model, thinkingLevel);
      const fallback = this.recent();
      const record = this.registry.get(id);
      if (!record) throw new DomainError('not_found', 'Conversation not found');
      signal?.throwIfAborted();
      const prepared = this.registry.prepareInput(id, prompt, attachments);
      const publish = (event: StreamEvent) => {
        if (event.type === 'user') activity.events!.info.inputEntryId = event.message.id;
        this.publish(activity, event);
        if (event.type === 'user') {
          this.observe({
            type: 'input-accepted',
            sessionId: id,
            parentId: record.parentId,
            source: event.source,
            runSource: source ?? 'user',
            model: event.model,
          });
        }
      };
      const task = this.tasks.start<string>(
        {
          owner: 'session:' + id,
          type: 'agent-run',
          metadata,
          provider,
          signal,
          acquire,
        },
        async (task) => {
          try {
            const answer = await this.withAgentContext(id, activity, task.signal, (ctx, signal) =>
              this.sessionRun.prompt(ctx, record, prepared.text, publish, {
                fallback,
                beginSubmission: () => {
                  activity.events!.info.inputEntryId = null;
                },
                signal,
                source,
                task,
                submissionId: task.id,
                choice: model,
                images: prepared.images,
                input: prepared.input,
                thinkingLevel,
                revision,
                changed: (path) => {
                  const info = activity.events!.info;
                  info.changedFiles = [...new Set([...(info.changedFiles ?? []), path])];
                },
              }),
            );
            task.setResult(answer);
            return answer;
          } catch (error) {
            task.signal.throwIfAborted();
            throw error;
          }
        },
      );
      activity.task = task;
      this.changed(id);
      return { info: activity.events!.info, task };
    } catch (error) {
      activity.task?.cancel(error);
      this.work.delete(id);
      throw error;
    }
  }

  submit(id: string, { message, ...input }: RunInput, options: RunSubmission = {}) {
    return this.launch(id, message, undefined, { ...input, ...options, source: 'plugin' }).task;
  }

  async send(id: string, prompt: string, emit?: (event: StreamEvent) => void, options: RunOptions = {}) {
    return this.launch(id, prompt, emit, options).task.result;
  }

  startRun(
    id: string,
    prompt: string,
    { model, attachments, thinkingLevel }: Pick<RunOptions, 'model' | 'attachments' | 'thinkingLevel'> = {},
  ) {
    return { ...this.launch(id, prompt, undefined, { model, attachments, thinkingLevel }).info };
  }

  /** A run reservation protects branch navigation from concurrent submissions. */
  async reviseAndStart(
    id: string,
    input: {
      sourceEntryId: string;
      expectedLeafId: string | null;
      message: string;
      removedImages?: number[];
      attachments?: Attachment[];
      model?: ModelChoice;
      thinkingLevel?: ThinkingLevel | null;
    },
  ) {
    const reservation = this.reserve(id);
    try {
      const target = this.registry.revisionTarget(id, input.sourceEntryId, input.expectedLeafId);
      const removed = input.removedImages ?? [];
      if (
        !Array.isArray(removed) ||
        removed.some((index) => !Number.isInteger(index) || index < 0 || index >= target.images.length)
      )
        throw new DomainError('invalid_input', 'Invalid original image selection');
      const attached = input.attachments ?? [];
      if (!Array.isArray(attached)) throw new DomainError('invalid_input', 'Invalid attachments');
      const missing = target.textFiles.filter(
        (name) =>
          !attached.some(
            (file) =>
              file?.name === name && typeof file.mimeType === 'string' && !imageMimeType.test(file.mimeType),
          ),
      );
      if (missing.length)
        throw new DomainError('invalid_input', 'Reattach the original text files: ' + missing.join(', '));
      const attachments = [...target.images.filter((_, index) => !removed.includes(index)), ...attached];
      return {
        ...this.launch(
          id,
          input.message,
          undefined,
          {
            attachments,
            model: input.model,
            thinkingLevel: input.thinkingLevel,
            revision: { parentId: target.parentId, expectedLeafId: input.expectedLeafId },
          },
          reservation,
        ).info,
      };
    } catch (error) {
      this.work.delete(id);
      throw error;
    }
  }

  retryInput(id: string, runId: string) {
    const run = this.info(id);
    if (run?.id !== runId || run.state !== 'failed')
      throw new DomainError('conflict', 'This run is no longer the failed conversation run');
    return this.registry.inspectLog(id, (log) => {
      const entries = log.entries();
      const matches = (entry: (typeof entries)[number], state: RunInfo['state']) => {
        const item = runFromEntry(id, entry);
        return item?.id === runId && item.state === state;
      };
      const start = entries.findIndex((entry) => matches(entry, 'queued'));
      const end = entries.findIndex((entry, index) => index > start && matches(entry, 'failed'));
      if (start < 0 || end < 0) return;
      const delivered = entries
        .slice(start + 1, end)
        .filter((entry) => entry.type === 'message' && entry.message.role === 'user');
      const input =
        run.inputEntryId === undefined
          ? delivered.length === 1 && delivered[0].type === 'message' && delivered[0].submissionId === runId
            ? delivered[0]
            : undefined
          : delivered.find(({ id }) => id === run.inputEntryId);
      if (input?.type !== 'message' || input.message.role !== 'user') return;
      const { message, presentation, selection } = input;
      const parts = typeof message.content === 'string' ? [] : message.content;
      const attachments: Attachment[] = [],
        missing: string[] = [];
      for (const { name, mimeType, id: attachmentId, data } of userContent(message.content, presentation)
        .attachments) {
        const bytes = attachmentId && this.registry.readAttachment(id, attachmentId);
        if (bytes) attachments.push({ name, mimeType, data: bytes.toString('base64') });
        else if (data) attachments.push({ name, mimeType, data });
        else missing.push(name);
      }
      const text =
        typeof message.content === 'string'
          ? message.content
          : parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
      return {
        message: presentation?.userText ?? text,
        attachments,
        missing,
        model: selection?.model,
        thinkingLevel: selection?.thinkingLevel,
      };
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
      return {
        timeline: projection?.timeline ?? [],
        leafId: projection?.leafId ?? null,
        model: projection?.model,
        thinkingLevel: projection?.thinkingLevel,
      };
    };
    if (events) return events.watch(after, emit, history, end);
    emit({
      type: 'snapshot',
      ...history(),
      tools: [],
      run: info,
      sequence: info.sequence,
      runId: info.id,
      runSessionId: id,
    });
    return () => {};
  }

  queueInput(
    id: string,
    { message, mode, attachments, model, thinkingLevel }: Parameters<RunPort['queueInput']>[1],
  ) {
    this.assertOpen();
    const activity = this.work.get(id);
    const signal = activity?.task?.signal;
    if (!activity?.context || !signal || signal.aborted || activity.context.fiber.signal.aborted)
      throw new DomainError('conflict', 'The agent is not streaming; send a new message');
    this.registry.assertAvailable(id);
    const models = activity.context.get('harnessModels');
    if (!models) throw new DomainError('unavailable', 'Required service is unavailable: harnessModels');
    return new Inbox(this.registry.log(id)).enqueue(
      mode,
      () => this.registry.prepareInput(id, message, attachments),
      models,
      { model, thinkingLevel, fallback: this.recent() },
    );
  }

  async cancelQueue(id: string, itemId?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.assertOpen();
    this.registry.assertAvailable(id);
    return new Inbox(this.registry.log(id)).cancel('User cancelled', itemId);
  }

  cancel(id: string) {
    const activity = this.work.get(id);
    return (
      activity?.task?.cancel(new Error(activity.events ? 'Agent run cancelled' : 'Compaction cancelled')) ??
      false
    );
  }

  async compact(id: string) {
    const activity = this.reserve(id);
    try {
      const task = this.tasks.start({ owner: 'session:' + id, type: 'compaction' }, ({ signal }) =>
        this.withAgentContext(id, activity, signal, (ctx, signal) =>
          this.sessionRun.compact(ctx, id, signal),
        ),
      );
      activity.task = task;
      this.changed(id);
      await task.result;
    } finally {
      this.work.delete(id);
      this.changed(id);
    }
  }

  private async withAgentContext<T>(
    id: string,
    activity: Activity,
    signal: AbortSignal,
    work: (ctx: Context, signal: AbortSignal) => Promise<T>,
  ) {
    const key = `session:${id}` as const;
    await this.scopes.prepare(key, signal);
    signal.throwIfAborted();
    const scope = this.scopes.context(key);
    const fiber = tagScope(scope.extend(), this.registry.runScope(id)!).inject(
      ['harnessAgent', 'harnessTasks'],
      () => {},
    );
    try {
      await fiber;
      if (!fiber.ctx.get('harnessAgent'))
        throw new DomainError('unavailable', 'Required service is unavailable: harnessAgent');
      activity.context = fiber.ctx;
      return await fiber.run(async (signal) => {
        for (const { context, callback } of fiber.ctx.events.listeners('agent/setup', scopeTarget(fiber.ctx)))
          await context.fiber.run((signal) => callback(fiber.ctx, id, signal), signal);
        return work(fiber.ctx, signal);
      }, signal);
    } finally {
      activity.context = undefined;
      await fiber.dispose();
    }
  }
}
