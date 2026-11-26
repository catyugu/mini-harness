import { toolAvailable } from '@mini-harness/tools/execution';
import { displayMessage } from '@mini-harness/sessions/projection';
import { conversationTools } from './tool-selection.ts';
import type { Context } from 'mini-harness/cordis';
import type { TaskContext } from '@mini-harness/tasks/api';
import { scopeTarget } from '@mini-harness/plugin-api/scopes';
import type { InputContext, ModelFailure, StepContext } from '@mini-harness/agent/events';
import { DomainError } from '@mini-harness/platform/errors';
import { isDeepStrictEqual } from 'node:util';
import type { SessionCatalog, SessionLifecycle, SessionStore } from '@mini-harness/sessions/records';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelCatalogPort } from '@mini-harness/models/api';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import {
  validateNativeMessage,
  type LlmRequest,
  type ModelRequestContent,
  type NativeAssistantMessage,
  type NativeUserMessage,
  type ToolCallPart,
} from '@mini-harness/llm/api';
import type { AgentEvent } from './stream.ts';
import type { MessageOrigin, MessageMode } from '@mini-harness/sessions/queue';
import type { SessionLogPort, InboxItem, SessionProjection } from '@mini-harness/sessions/log-api';
import { Inbox } from './inbox.ts';
import { isToolContent, toolResultState } from '@mini-harness/tools/api';
import { applyTransforms } from './transforms.ts';
import { toolFailure } from '@mini-harness/tools/execution';
import {
  prepareModelMessages,
  resolveThinking,
  selectModel,
  assertImageInput,
} from '@mini-harness/models/selection';
import { NothingToCompact } from '@mini-harness/agent/compaction';
import { requestModel } from '@mini-harness/agent/model-request';

function requireService<K extends keyof Context & string>(ctx: Context, name: K): NonNullable<Context[K]> {
  const value = ctx.get(name);
  if (value == null) throw new DomainError('unavailable', 'Required service is unavailable: ' + name);
  return value;
}

async function retryModel(ctx: Context, failure: ModelFailure & { sessionId: string }) {
  const { signal, ...input } = failure;
  for (const { context, callback } of ctx.events.listeners('agent/model-retry', scopeTarget(ctx))) {
    const retry = await context.fiber.run((signal) => callback({ ...input, signal }), signal);
    if (retry === undefined) continue;
    return retry;
  }
}

const textOf = (message: NativeAssistantMessage) =>
  message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
interface SessionPrompt {
  signal: AbortSignal;
  task: TaskContext;
  fallback?: ModelChoice;
  changed?: (path: string) => void;
  revision?: Pick<InboxItem, 'text' | 'images' | 'input' | 'model' | 'thinkingLevel'> & {
    parentId: string | null;
    expectedLeafId: string | null;
  };
}

export function selectInputModel(
  models: ModelCatalogPort,
  item: Pick<InboxItem, 'model' | 'thinkingLevel'> & Partial<Pick<InboxItem, 'mode' | 'origin'>>,
  previous: Pick<SessionProjection, 'model' | 'thinkingLevel'>,
  fallback: ModelChoice | undefined,
  parentId: string | null,
) {
  return selectModel(models, {
    explicit: item.model,
    stored: previous.model,
    fallback,
    preferStored: Boolean(parentId || item.mode === 'steer' || item.origin?.source !== 'user'),
    thinkingLevel: item.thinkingLevel,
    inherited: previous.thinkingLevel,
  });
}

export class SessionRun {
  constructor(
    private readonly sessions: Pick<SessionCatalog, 'workspacePath'> &
      Pick<SessionLifecycle, 'assertAvailable' | 'rename'> &
      Pick<SessionStore, 'log'>,
  ) {}

  /** Never retry an unknown tool outcome after restart or provider failure. */
  private closeUnfinishedTools(log: SessionLogPort, cancelled = false) {
    const pending = new Map<string, ToolCallPart>();
    for (const message of log.projection().contextMessages) {
      if (message.role === 'assistant')
        for (const part of message.content) if (part.type === 'toolCall') pending.set(part.id, part);
      if (message.role === 'toolResult') pending.delete(message.toolCallId);
    }
    if (!pending.size) return;
    const branch = new Set(log.branch().map(({ id }) => id));
    const executed = new Map(
      log
        .entries()
        .flatMap((entry) =>
          entry.type === 'tool-execution' && entry.parentId !== null && branch.has(entry.parentId)
            ? [[entry.result.toolCallId, entry] as const]
            : [],
        ),
    );
    for (const call of pending.values()) {
      const execution = executed.get(call.id);
      if (execution) log.acceptToolResult(execution.id, execution.result.content);
      else
        log.append({
          type: 'message',
          message: toolFailure(
            call,
            cancelled ? 'Tool call interrupted' : 'Execution stopped before a durable result was recorded.',
            'cancelled',
          ),
        });
    }
  }

  async prompt(
    ctx: Context,
    record: SessionRecord,
    emit: (event: AgentEvent) => void | Promise<void>,
    options: SessionPrompt,
  ): Promise<string> {
    const { id } = record;
    const { signal, task, revision, changed, fallback } = options;
    const submissionId = task.id;
    signal.throwIfAborted();
    const log = this.sessions.log(id);
    if (!revision) this.closeUnfinishedTools(log);
    const inbox = new Inbox(log);
    type Input = Pick<InboxItem, 'text' | 'images' | 'input' | 'model' | 'thinkingLevel'> &
      Partial<Pick<InboxItem, 'mode' | 'origin'>>;

    const selection = (item: Input, previous = log.projection()) => {
      const models = requireService(ctx, 'harnessModels');
      const selected = selectInputModel(models, item, previous, fallback, record.parentId);
      assertImageInput(models.capabilities(selected.model), item.images.length);
      validateNativeMessage({
        role: 'user',
        content: [{ type: 'text', text: item.text }, ...item.images],
        timestamp: 0,
      });
      return selected;
    };

    const prepare = async (item: Input, selected: ReturnType<typeof selection>, origin: MessageOrigin) => {
      const presentation = item.input ?? { userText: item.text, attachments: [] };
      const context: InputContext = {
        sessionId: id,
        model: selected.model,
        source: origin.source,
        signal,
        original: { ...presentation, images: item.images },
        cwd: this.sessions.workspacePath(id),
      };
      const sender = origin.senderSessionId ? ' from session ' + origin.senderSessionId : '';
      const taskRef = origin.taskId ? ' (task ' + origin.taskId + ')' : '';
      const text =
        origin.source === 'user' ? item.text : '[' + origin.source + sender + taskRef + '] ' + item.text;
      const initial: NativeUserMessage['content'] = [{ type: 'text', text }, ...item.images];
      const content = await applyTransforms(
        ctx.events.listeners('agent/prepare-input', scopeTarget(ctx)),
        initial,
        context,
      );
      validateNativeMessage({ role: 'user', content, timestamp: 0 });
      const preparedImages =
        typeof content === 'string' ? [] : content.filter((part) => part.type === 'image');
      assertImageInput(
        requireService(ctx, 'harnessModels').capabilities(selected.model),
        preparedImages.length,
      );
      signal.throwIfAborted();
      this.sessions.assertAvailable(id);
      return {
        selection: selected,
        presentation: isDeepStrictEqual(item.images, preparedImages)
          ? presentation
          : { ...presentation, images: item.images },
        content,
      };
    };

    const commit = async (
      item: Input,
      prepared: Awaited<ReturnType<typeof prepare>>,
      origin: MessageOrigin,
      inboxId?: string,
    ) => {
      signal.throwIfAborted();
      this.sessions.assertAvailable(id);
      const edit = inboxId ? undefined : revision;
      const event = {
        type: 'message',
        message: { role: 'user', content: prepared.content, timestamp: Date.now() },
        presentation: prepared.presentation,
        selection: prepared.selection,
        submissionId,
        inboxId,
        origin,
      } as const;
      const first = log
        .projection(edit?.parentId)
        .timeline.every((item) => item.type !== 'message' || item.role !== 'user');
      const entry = edit ? log.revise(event, edit.parentId, edit.expectedLeafId) : log.append(event);
      await emit({
        type: 'user',
        source: origin.source,
        ...prepared.selection,
        revised: Boolean(edit),
        message: displayMessage(entry, event.message, submissionId),
      });
      if (record.titleSource === 'auto' && first && origin.source === 'user') {
        const title = item.input?.userText || item.input?.attachments[0]?.name || item.text;
        this.sessions.rename(id, title.slice(0, 72), 'auto');
      }
    };
    const originOf = (item: InboxItem): MessageOrigin => item.origin ?? { source: 'user' };
    const deliver = (modes: MessageMode[], requireInput = false) =>
      inbox.deliver(
        modes,
        signal,
        (item) => prepare(item, selection(item), originOf(item)),
        (item, prepared) => commit(item, prepared, originOf(item), item.id),
        requireInput,
      );
    if (revision) {
      const origin = { source: 'user' } as const;
      await commit(
        revision,
        await prepare(revision, selection(revision, log.projection(revision.parentId)), origin),
        origin,
      );
      this.closeUnfinishedTools(log);
    } else {
      if (!(await deliver(['interrupt', 'steer', 'queue'], true))) return '';
      while (await deliver(['interrupt'])) {
        // Coalesce messages accepted during the same interruption before requesting a model turn.
      }
    }
    const answer = await requireService(ctx, 'harnessAgent')
      .run(ctx, {
        signal,
        retry: (failure) => retryModel(ctx, { ...failure, sessionId: id }),
        onEvent: (event) => {
          if (event.type === 'phase') {
            task.update({ phase: event.phase, turn: event.turn });
            return;
          }
          if (event.type === 'request') {
            log.recordRequest(event.request);
            return;
          }
          if (event.type !== 'assistant') {
            emit(event);
            return;
          }
          const { diagnostic, message: result } = event;
          if (diagnostic) log.append({ type: 'diagnostic', code: diagnostic.code, data: diagnostic.message });
          const assistant = log.append({ type: 'message', message: result });
          emit({
            type: 'assistant-end',
            message: displayMessage(assistant, result, submissionId),
          });
        },
        afterTurn: async () => {
          if (await deliver(['steer'])) return 'continue';
        },
        prepare: async (turn) => {
          let current = log.projection();
          const model = current.model;
          if (!model) throw new Error('Configure a model before sending a message');
          const capabilities = requireService(ctx, 'harnessModels').capabilities(model);
          const cwd = this.sessions.workspacePath(id);
          const step: StepContext = { sessionId: id, turn, phase: 'turn', cwd, model, signal };
          if (
            capabilities &&
            ctx.get('harnessCompaction')?.shouldCompact(current.contextMessages, capabilities)
          ) {
            await this.compactLog(ctx, id, log, signal, true);
            current = log.projection();
          }
          const executor = requireService(ctx, 'harnessToolExecutor');
          const tools = conversationTools(ctx, id);
          const advertisedTools = new Map(tools.map((tool) => [tool.name, tool]));
          const toolMetadata = tools.map(({ name, description, parameters, label, metadata }) => ({
            name,
            description,
            parameters,
            label,
            metadata,
          }));
          const systemPrompt =
            (await ctx.get('harnessPrompt')?.build({ sessionId: id, cwd, tools: toolMetadata, signal })) ??
            '';
          const request = await this.prepareRequest(
            ctx,
            step,
            { systemPrompt, messages: current.contextMessages, thinkingLevel: current.thinkingLevel },
            (content) => {
              for (const [name, tool] of advertisedTools)
                if (!toolAvailable(tool)) advertisedTools.delete(name);
              const available = toolMetadata
                .filter(({ name }) => advertisedTools.has(name))
                .map(({ name, description, parameters }) => ({ name, description, parameters }));
              return executor.present(content, available, { model: step.model, turn, signal });
            },
          );

          const hooks = ctx.events.listeners('agent/tool-result', scopeTarget(ctx));
          return {
            request,
            executor,
            tools: advertisedTools,
            execution: {
              executionId: task.id,
              async waitFor(id, signal) {
                await task.waitFor(id, signal);
              },
              start(call) {
                if (signal.aborted) return { outcome: 'skipped', reason: 'Agent run cancelled' };
                if (inbox.hasValid('steer', selection))
                  return { outcome: 'skipped', reason: 'Skipped because a steering message arrived.' };
                const tool = advertisedTools.get(call.name);
                if (tool && ctx.get('harnessToolPolicy')?.(id, tool) === false)
                  return { outcome: 'denied', reason: 'Tool denied by conversation policy: ' + call.name };
                emit({
                  type: 'tool',
                  id: call.id,
                  name: call.name,
                  state: 'running',
                  arguments: call.arguments,
                });
                return undefined;
              },
              update(call, value) {
                const pending = value.details?.approvalPending;
                if (pending === undefined && hooks.length) return;
                emit({
                  type: 'tool',
                  id: call.id,
                  name: call.name,
                  state: pending === true ? 'approval' : 'running',
                  arguments: call.arguments,
                  content: hooks.length ? undefined : value.content,
                });
              },
            },
            async deliver(output, toolSignal, call) {
              let executionId: string | undefined;
              let transformError: Error | undefined;
              if (toolResultState(output) === 'finished' && hooks.length) {
                executionId = log.append({ type: 'tool-execution', result: output }).id;
                try {
                  const resultContext = { ...step, signal: toolSignal, tool: call.name, callId: call.id };
                  const content = await applyTransforms(hooks, output.content, resultContext);
                  if (!isToolContent(content)) throw new Error('Invalid tool result content');
                  output = { ...output, content };
                } catch (error) {
                  if (!toolSignal.aborted) {
                    output = {
                      ...toolFailure(
                        call,
                        'Tool execution completed, but the model-visible result transformation failed.',
                      ),
                      elapsedMs: output.elapsedMs,
                    };
                    transformError = new Error('Could not transform the result of ' + call.name, {
                      cause: error,
                    });
                  }
                }
              }
              const entry =
                executionId && !transformError
                  ? log.acceptToolResult(executionId, output.content)
                  : log.append({ type: 'message', message: output, elapsedMs: output.elapsedMs });
              const details = output.details;
              const state = toolResultState(output);
              if (state === 'finished' && typeof details?.changedPath === 'string')
                changed?.(details.changedPath);
              emit({
                type: 'tool-end',
                message: displayMessage(entry, output, submissionId, call.arguments),
              });
              if (transformError) throw transformError;
            },
          };
        },
      })
      .catch((error) => {
        if (signal.aborted) this.closeUnfinishedTools(log, true);
        throw error;
      });
    const text = textOf(answer);
    emit({ type: 'complete', text });
    return text;
  }

  private async prepareRequest(
    ctx: Context,
    context: StepContext,
    requestContent: ModelRequestContent,
    present?: (content: ModelRequestContent) => ModelRequestContent & { tools?: LlmRequest['tools'] },
  ): Promise<LlmRequest> {
    const transformed = await applyTransforms(
      ctx.events.listeners('agent/model-request', scopeTarget(ctx)),
      requestContent,
      context,
    );
    const prepared = present ? present(transformed) : transformed;
    const capabilities = requireService(ctx, 'harnessModels').capabilities(context.model);
    resolveThinking(capabilities, prepared.thinkingLevel);
    return {
      ...prepared,
      messages: prepareModelMessages(capabilities, prepared.messages),
      model: context.model,
      signal: context.signal,
    };
  }

  private async compactLog(
    ctx: Context,
    id: string,
    log: SessionLogPort,
    signal: AbortSignal,
    automatic = false,
  ) {
    const strategy = ctx.get('harnessCompaction');
    if (!strategy) {
      if (automatic) return;
      throw new DomainError('unavailable', 'Context compaction is disabled');
    }
    this.closeUnfinishedTools(log);
    const projection = log.projection();
    const summarized = log
      .branch()
      .some(({ type, id }) => type === 'compaction' && id === projection.contextEntryIds[0]);
    const result = await strategy
      .compact({
        messages: projection.contextMessages,
        summarized,
        automatic,
        signal,
        request: async (content) => {
          signal.throwIfAborted();
          const { model } = selectModel(requireService(ctx, 'harnessModels'), {
            explicit: projection.model,
            unavailable: 'Configure a model before compacting',
          });
          const context: StepContext = {
            sessionId: id,
            cwd: this.sessions.workspacePath(id),
            model,
            turn: 0,
            phase: 'compaction',
            signal,
          };
          const request = await this.prepareRequest(ctx, context, content);
          log.recordRequest(request);
          return requestModel(requireService(ctx, 'harnessLlm'), request, {
            retry: (failure) => retryModel(ctx, { ...failure, sessionId: id }),
          });
        },
      })
      .catch((error) => {
        if (error instanceof NothingToCompact) throw new DomainError('invalid_input', error.message);
        throw error;
      });
    signal.throwIfAborted();
    if (!result) return;
    const { keepFromIndex } = result;
    const keepFromId = projection.contextEntryIds[keepFromIndex];
    if (
      typeof result.summary !== 'string' ||
      !result.summary.trim() ||
      !Number.isInteger(keepFromIndex) ||
      keepFromIndex <= 0 ||
      !keepFromId ||
      projection.contextMessages[keepFromIndex]?.role !== 'user' ||
      (result.tokensBefore !== undefined &&
        (!Number.isFinite(result.tokensBefore) || result.tokensBefore < 0))
    )
      throw new Error('Invalid compaction result');
    log.append(
      {
        type: 'compaction',
        summary: result.summary,
        keepFromId,
        tokensBefore: result.tokensBefore,
      },
      projection.leafId,
    );
  }

  async compact(ctx: Context, id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.sessions.assertAvailable(id);
    await this.compactLog(ctx, id, this.sessions.log(id), signal);
  }
}
