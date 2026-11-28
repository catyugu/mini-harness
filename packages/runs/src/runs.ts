import type { RecordAppend } from '@mini-harness/sessions/display-record';
import { userContent } from '@mini-harness/sessions/user-content';
import { randomUUID } from 'node:crypto';
import type { Context } from 'mini-harness/cordis';
import { tagScope, scopeTarget } from '@mini-harness/plugin-api/scopes';
import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ProfileScopes } from '@mini-harness/plugin-api/configuration';
import { DomainError } from '@mini-harness/platform/errors';
import { terminal, type TaskEvent, type TaskPort, type TaskSnapshot } from '@mini-harness/tasks/api';
import { imageMimeType } from '@mini-harness/input/prepare';
import { validateModelOptions } from '@mini-harness/llm/options';
import { defaultMessageMode, messageModes } from '@mini-harness/sessions/queue';
import type { Attachment, InputSource } from '@mini-harness/input/message';
import type { CapabilityObservation } from '@mini-harness/plugin-api/observations';
import { Inbox } from './inbox.ts';
import { assertImageInput } from '@mini-harness/models/selection';
import { selectInputModel, SessionRun } from './session-run.ts';
import { recordPublisher, type RunEvent } from './shared/stream.ts';
import { isRunning, type RunDetails, type RunInfo } from './shared/run-state.ts';
import { projectTimeline, recordRun, runRecords, settledRuns } from './history.ts';
import { RunEvents } from './events.ts';
import type { RunInput, RunPolicy, RunPort, RunSubmission } from './api.ts';
import type { SessionStore } from '@mini-harness/sessions/records';

interface Revision extends RunInput {
  parentId: string | null;
  expectedLeafId: string | null;
}

function projectRun(sessionId: string, task: TaskSnapshot, details: RunDetails): RunInfo {
  return {
    ...details,
    id: task.id,
    sessionId,
    state: task.state,
    startedAt: task.createdAt,
    executedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
  };
}

export class Runs implements RunPort {
  readonly events = new EventTarget();
  private readonly streams = new Map<string, RunEvents>();

  constructor(
    private readonly ctx: Context,
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

  current(id: string) {
    const task = this.tasks.active(this.lane(id));
    return task && (this.streams.get(id)?.handle ?? task);
  }

  private lane(id: string) {
    return 'conversation:' + id;
  }

  private assertOpen() {
    if (this.tasks.sealed) throw new DomainError('unavailable', 'Runs are closing');
  }

  activity(id: string) {
    const events = this.streams.get(id);
    return {
      partial: events?.partial,
      tools: events?.activeTools ?? [],
      records: events?.activeRecords ?? [],
    };
  }

  liveRecords(id: string, runId: string) {
    return recordPublisher((event) => {
      const events = this.streams.get(id);
      if (!events || events.info.id !== runId || !isRunning(events.info))
        throw new DomainError('not_found', 'Run not found');
      events.publish(event);
    });
  }

  recordChange(id: string, executionId: string, path: string) {
    const info = this.streams.get(id)?.info;
    if (info?.id === executionId && isRunning(info))
      info.changedFiles = [...new Set([...(info.changedFiles ?? []), path])];
  }

  branchChanged(id: string, record: RecordAppend) {
    const events = this.streams.get(id);
    if (!events || !isRunning(events.info)) return;
    events.publish({ type: 'branch', ...record });
  }

  private assertIdle(id: string) {
    const record = this.registry.assertAvailable(id);
    this.assertOpen();
    if (this.current(id)) throw new DomainError('conflict', 'Conversation is already running');
    return record;
  }

  private taskChanged(id: string, { type, task }: TaskEvent) {
    if (type !== 'transition') return;
    const events = this.streams.get(id);
    if (events?.info.id !== task.id) return;
    const info = events.info;
    const firstAdmission = !info.executedAt && task.state === 'running';
    const ended = terminal(task.state);
    try {
      const next = projectRun(id, task, {
        inputEntryId: info.inputEntryId,
        changedFiles: info.changedFiles,
        sequence: info.sequence + 1 + Number(task.state === 'failed' && Boolean(task.error)),
      });
      if (ended) recordRun(this.registry, next);
      if (next.state === 'failed' && next.error) events.publish({ type: 'error', error: next.error });
      Object.assign(info, next, { sequence: info.sequence });
      events.publish({ type: 'run', run: next });
      if (firstAdmission)
        this.observe({ type: 'run-started', sessionId: id, run: next }, this.current(id)?.signal);
    } catch (error) {
      this.ctx.logger.error('Could not record run ' + task.id, error);
      events.writeError = new Error('Run settlement could not be saved', { cause: error });
      events.publish({ type: 'error', error: events.writeError.message });
    } finally {
      if (ended) {
        this.streams.delete(id);
        events.close();
      }
      this.changed(id);
    }
  }

  private launch(id: string, revision?: Revision) {
    const record = this.assertIdle(id);
    const fallback = this.recent();
    const prepared = revision && {
      ...this.registry.prepareInput(id, revision.message, revision.attachments),
      model: revision.model,
      thinkingLevel: revision.thinkingLevel,
      parentId: revision.parentId,
      expectedLeafId: revision.expectedLeafId,
    };
    const owner = this.lane(id);
    const context = this.scopes.context(`session:${id}`);
    const policy: RunPolicy | undefined = context.bail('runs/policy', id);
    const pending = new Set(
      this.registry
        .log(id)
        .inbox()
        .map(({ id }) => id),
    );
    let runSource: InputSource | undefined;
    let events: RunEvents;
    const task = this.tasks.start<string>(
      {
        owner,
        onEvent: (event) => this.taskChanged(id, event),
        lane: this.lane(id),
        provider: policy?.provider ?? this.ctx,
        signal: this.ctx.fiber.signal,
        pool: policy?.pool,
      },
      (task) => {
        return this.withAgentContext(id, task.signal, (ctx, signal) =>
          this.sessionRun.prompt(
            ctx,
            record,
            (event) => {
              if (event.type !== 'user') {
                events.publish(event);
                return;
              }
              events.info.inputEntryId = event.message.id;
              runSource ??= event.source;
              events.publish(event);
              this.observe({
                type: 'input-accepted',
                sessionId: id,
                parentId: record.parentId,
                source: event.source,
                runSource,
                model: event.model,
              });
            },
            {
              fallback,
              signal,
              task,
              revision: prepared,
            },
          ),
        ).catch((error) => {
          task.signal.throwIfAborted();
          throw error;
        });
      },
    );
    const info = projectRun(id, task.snapshot(), { sequence: 0, inputEntryId: null });
    try {
      recordRun(this.registry, info);
    } catch (error) {
      task.cancel(error);
      throw error;
    }
    events = new RunEvents(info, task);
    this.streams.set(id, events);
    const settled = (answer?: string) => {
      if (!events.writeError)
        this.observe({ type: 'run-ended', sessionId: id, run: structuredClone(info), answer });
    };
    void events.handle.result.then(
      (answer) => {
        settled(answer);
        this.wake(id);
      },
      () => {
        settled(info.error);
        this.wake(
          id,
          pending,
          task.signal.reason instanceof DOMException &&
            task.signal.reason.message === 'Interrupted by a new message',
        );
      },
    );
    this.changed(id);
    return { info, task: events.handle };
  }

  send(id: string, input: RunSubmission) {
    this.assertOpen();
    this.registry.assertAvailable(id);
    const origin = input.origin ?? { source: 'plugin' };
    const mode = input.mode ?? (origin.source === 'user' ? defaultMessageMode : 'queue');
    if (!messageModes.includes(mode)) throw new DomainError('invalid_input', 'Invalid message mode');
    const log = this.registry.log(id);
    const messageId = input.messageId ?? randomUUID();
    if (typeof messageId !== 'string' || !messageId || messageId.length > 200)
      throw new DomainError('invalid_input', 'Invalid message ID');
    if (log.hasInbox(messageId))
      return { messageId, taskId: this.current(id)?.id, run: this.info(id), queue: log.queue() };
    if ((origin.source === 'user' || origin.source === 'plugin') && log.inbox().length >= 16)
      throw new DomainError('conflict', 'Queue is full');
    validateModelOptions(input.model, input.thinkingLevel);
    const selection = { mode, origin, model: input.model, thinkingLevel: input.thinkingLevel };
    const imageCount = Array.isArray(input.attachments)
      ? input.attachments.filter(
          (file) => typeof file?.mimeType === 'string' && imageMimeType.test(file.mimeType),
        ).length
      : 0;
    if (imageCount) {
      let context: Context | undefined;
      try {
        context = this.scopes.context(`session:${id}`);
      } catch (error) {
        // Lazy scopes resolve their model during delivery.
        if (!(error instanceof DomainError) || error.code !== 'unavailable') throw error;
      }
      const models = context?.get('harnessModels');
      if (models) {
        const { capabilities } = selectInputModel(
          models,
          selection,
          log.projection(),
          this.recent(),
          this.registry.get(id)?.parentId ?? null,
        );
        assertImageInput(capabilities, imageCount);
      }
    }
    log.append({
      type: 'inbox-enqueued',
      item: {
        id: messageId,
        ...selection,
        ...this.registry.prepareInput(id, input.message, input.attachments),
        ...(origin.source === 'user' && { resume: true }),
      },
    });
    const active = this.current(id);
    if (active && this.streams.has(id) && mode === 'interrupt' && !log.inboxPaused())
      active.cancel(new DOMException('Interrupted by a new message', 'AbortError'));
    const task = active ?? this.wake(id);
    return { messageId, taskId: task?.id, run: this.info(id), queue: log.queue() };
  }

  stop(id: string) {
    this.assertOpen();
    this.registry.assertAvailable(id);
    const current = this.current(id);
    if (!current || this.streams.has(id)) {
      const log = this.registry.log(id);
      if (!log.inboxPaused()) log.append({ type: 'inbox-paused' });
    }
    return current?.cancel(new DOMException('Stopped by the user', 'AbortError')) ?? false;
  }

  private wake(id: string, previous?: ReadonlySet<string>, interrupted = false) {
    if (this.tasks.sealed || this.current(id)) return;
    try {
      this.registry.assertAvailable(id);
      const log = this.registry.log(id);
      const pending = log.inbox();
      if (log.inboxPaused() || !pending.length) return;
      // Retry only when the previous executor advanced the inbox or new work arrived.
      if (
        !interrupted &&
        previous &&
        pending.length === previous.size &&
        pending.every(({ id }) => previous.has(id))
      )
        return;
      return this.launch(id).task;
    } catch (error) {
      if (error instanceof DomainError && (error.code === 'not_found' || error.code === 'conflict')) return;
      this.ctx.logger.error('Could not wake conversation ' + id, error);
    }
  }

  recover() {
    for (const { id } of this.registry.list()) {
      if (this.current(id)) continue;
      const run = this.info(id);
      if (run && isRunning(run)) {
        const ended: RunInfo = {
          ...run,
          state: 'interrupted',
          finishedAt: new Date().toISOString(),
          error: 'Run interrupted before settlement was recorded',
        };
        recordRun(this.registry, ended);
        this.observe({ type: 'run-ended', sessionId: id, run: ended, answer: ended.error });
      }
    }
    for (const id of this.registry.readyInboxSessions()) this.wake(id);
  }

  /** Revision preparation and task admission happen in one synchronous turn. */
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
    this.assertIdle(id);
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
      ...this.launch(id, {
        message: input.message,
        attachments,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        parentId: target.parentId,
        expectedLeafId: input.expectedLeafId,
      }).info,
    };
  }

  retryInput(id: string, runId: string) {
    const run = this.info(id);
    if (run?.id !== runId || run.state !== 'failed')
      throw new DomainError('conflict', 'This run is no longer the failed conversation run');
    return this.registry.inspectLog(id, (log) => {
      const input = log.entries().find(({ id }) => id === run.inputEntryId);
      if (input?.type !== 'message' || input.message.role !== 'user') return;
      const { message, presentation, selection } = input;
      const attachments: Attachment[] = [],
        missing: string[] = [];
      for (const { name, mimeType, id: attachmentId, data } of userContent(message.content, presentation)
        .attachments) {
        const bytes = attachmentId && this.registry.readAttachment(id, attachmentId);
        if (bytes) attachments.push({ name, mimeType, data: bytes.toString('base64') });
        else if (data) attachments.push({ name, mimeType, data });
        else missing.push(name);
      }
      const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
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
    const info = this.streams.get(id)?.info ?? runRecords(this.registry, id, 1)[0]?.data;
    return info && structuredClone(info);
  }

  history(id: string, leafId?: string | null) {
    return this.registry.inspectLog(id, (log) => projectTimeline(log, runRecords(this.registry, id), leafId));
  }

  settlements(id: string) {
    return this.registry.inspectLog(id, (log) => settledRuns(log, runRecords(this.registry, id))) ?? [];
  }

  async wait(id: string, waitFor: ((taskId: string) => Promise<void>) | undefined, signal: AbortSignal) {
    const events = this.streams.get(id);
    if (!events) return this.info(id);
    const taskId = events.info.id;
    if (waitFor) await waitFor(taskId);
    else await this.tasks.wait(taskId, signal);
    if (events.writeError) throw events.writeError;
    return structuredClone(events.info);
  }

  async remove(id: string) {
    await this.tasks.removeOwner(this.lane(id));
  }

  watch(id: string, runId: string, after: number, emit: (event: RunEvent) => void, end?: () => void) {
    const events = this.streams.get(id);
    const info = this.info(id);
    if (!info || info.id !== runId) throw new DomainError('not_found', 'Run not found');
    // A restarted run has no volatile delta cursor; its durable interrupted snapshot is authoritative.
    if (!Number.isSafeInteger(after) || after < 0 || (after > info.sequence && info.state !== 'interrupted'))
      throw new DomainError('invalid_input', 'Invalid event cursor');
    const history = () => {
      const projection = this.history(id);
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
      records: [],
      run: info,
      sequence: info.sequence,
      runId: info.id,
      runSessionId: id,
    });
    return () => {};
  }

  async cancelQueue(id: string, itemId?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.assertOpen();
    this.registry.assertAvailable(id);
    return new Inbox(this.registry.log(id)).cancel('User cancelled', itemId);
  }

  async runTask<T>(
    provider: Context,
    id: string,
    work: (ctx: Context, signal: AbortSignal, taskId: string) => Promise<T>,
  ) {
    this.assertIdle(id);
    const task = this.tasks.start(
      { owner: this.lane(id), lane: this.lane(id), provider, signal: this.ctx.fiber.signal },
      ({ id: taskId, signal }) =>
        this.withAgentContext(id, signal, async (ctx, signal) => {
          this.sessionRun.closeUnfinishedTools(this.registry.log(id));
          return work(ctx, signal, taskId);
        }),
    );
    this.changed(id);
    try {
      return await task.result;
    } finally {
      this.changed(id);
      this.wake(id);
    }
  }

  private async withAgentContext<T>(
    id: string,
    signal: AbortSignal,
    work: (ctx: Context, signal: AbortSignal) => Promise<T>,
  ) {
    const key = `session:${id}` as const;
    await this.scopes.prepare(key, signal);
    signal.throwIfAborted();
    const scope = this.scopes.context(key);
    const keyForRun = this.registry.runScope(id)!;
    const services = ['harnessAgent', 'harnessModels', 'harnessLlm', 'harnessToolExecutor'];
    const fiber = tagScope(scope.extend(), keyForRun).inject(services, () => {});
    try {
      await fiber;
      for (const service of services)
        if (!fiber.ctx.get(service))
          throw new DomainError('unavailable', 'Required service is unavailable: ' + service);
      return await fiber.run(async (signal) => {
        for (const { context, callback } of fiber.ctx.events.listeners(
          'agent/setup',
          scopeTarget(fiber.ctx),
        )) {
          await context.fiber.run(async (signal) => {
            const release = await callback(fiber.ctx, id, signal);
            if (!release) return;
            if (signal.aborted) await release();
            else fiber.ctx.effect(() => context.effect(() => release));
          }, signal);
        }
        return work(fiber.ctx, signal);
      }, signal);
    } finally {
      await fiber.dispose();
    }
  }
}
