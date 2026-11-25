import { conversationTools } from './tool-selection.ts';
import type { Context } from 'mini-harness/cordis';
import { scopeTarget } from '@mini-harness/plugin-api/scopes';
import { imageMimeType } from '@mini-harness/input/prepare';
import { validateModelOptions } from '@mini-harness/llm/options';
import type {
  InputContext,
  ModelFailure,
  ModelRequestContent,
  StepContext,
} from '@mini-harness/agent/events';
import { DomainError } from '@mini-harness/platform/errors';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { ToolExecutorPort } from '@mini-harness/agent/api';
import type {
  SessionCatalog,
  SessionHistory,
  SessionLifecycle,
  SessionStore,
} from '@mini-harness/sessions/store';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import type { ModelCatalogPort } from '@mini-harness/models/api';
import {
  validateNativeMessage,
  validateRequestSnapshot,
  type LlmRequest,
  type NativeAssistantMessage,
  type NativeMessage,
  type NativeUserMessage,
  type NativeToolMessage,
  type ToolCallPart,
} from '@mini-harness/llm/api';
import type { PromptPort } from '@mini-harness/agent/prompt-api';
import { RunInterrupted, type AgentEvent } from './stream.ts';
import type { Attachment, ImageInput, InputSource, PreparedMessage } from '@mini-harness/input/message';
import type { SessionLogPort, MessagePatch, InboxItem } from '@mini-harness/sessions/log-api';
import { Inbox } from './inbox.ts';
import { isToolContent } from '@mini-harness/tools/api';
import { contentDelta } from '@mini-harness/sessions/content-delta';
import { applyTransforms } from './transforms.ts';
import { failedTool } from '@mini-harness/agent/tool-pipeline';
import { resolveThinking, selectModel } from './model-selection.ts';
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
/** Store only the divergent interval of a transformed model context. */
function messagePatch(base: NativeMessage[], actual: NativeMessage[]): MessagePatch | undefined {
  let start = 0;
  while (start < base.length && start < actual.length && isDeepStrictEqual(base[start], actual[start]))
    start++;
  if (start === base.length && start === actual.length) return;
  let endBase = base.length,
    endActual = actual.length;
  while (
    endBase > start &&
    endActual > start &&
    isDeepStrictEqual(base[endBase - 1], actual[endActual - 1])
  ) {
    endBase--;
    endActual--;
  }
  return { start, deleteCount: endBase - start, insert: actual.slice(start, endActual) };
}

const imageNotice = '[Image unavailable to this model]';

function withoutImages(messages: NativeMessage[]): NativeMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant' || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'image' ? { type: 'text' as const, text: imageNotice } : part,
      ),
    };
  });
}

interface SessionPrompt {
  signal: AbortSignal;
  source?: InputSource;
  submissionId?: string;
  choice?: ModelChoice;
  images?: ImageInput[];
  input?: PreparedMessage;
  fallback?: ModelChoice;
  beginSubmission?(): void;
  thinkingLevel?: ThinkingLevel | null;
  changed?: (path: string) => void;
  revision?: { parentId: string | null; expectedLeafId: string | null };
}

export class SessionRun {
  private readonly recordedSchemas = new WeakMap<SessionLogPort, Set<string>>();

  constructor(
    private readonly sessions: Pick<SessionCatalog, 'workspacePath'> &
      Pick<SessionHistory, 'inspectLog'> &
      Pick<SessionLifecycle, 'assertAvailable' | 'rename'> &
      Pick<SessionStore, 'log' | 'prepareInput'>,
    private readonly policy: () => { autoCompact: boolean },
  ) {}

  revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null) {
    this.sessions.assertAvailable(id);
    if (
      typeof sourceEntryId !== 'string' ||
      !/^[a-f0-9]{8,64}$/i.test(sourceEntryId) ||
      (expectedLeafId !== null &&
        (typeof expectedLeafId !== 'string' || !/^[a-f0-9]{8,64}$/i.test(expectedLeafId)))
    )
      throw new DomainError('invalid_input', 'Invalid revision target');
    const target = this.sessions.inspectLog(
      id,
      (log) => {
        if (log.projection().leafId !== expectedLeafId)
          throw new DomainError('conflict', 'Conversation changed; refresh before editing');
        const source = log.branch().find((entry) => entry.id === sourceEntryId);
        if (source?.type !== 'message' || source.message.role !== 'user') return;
        const files = source.presentation?.attachments ?? [];
        const imageNames = files.filter((file) => imageMimeType.test(file.mimeType));
        const content = source.message.content;
        const images = (
          source.presentation?.images ??
          (typeof content === 'string' ? [] : content.filter((part) => part.type === 'image'))
        ).map(({ data, mimeType }, index) => ({
          data,
          mimeType,
          name: imageNames[index]?.name ?? 'Image ' + (index + 1),
        }));
        return {
          parentId: source.parentId,
          images,
          textFiles: files
            .filter((file) => !file.id && !imageMimeType.test(file.mimeType))
            .map(({ name }) => name),
        };
      },
      true,
    );
    if (!target) throw new DomainError('invalid_input', 'User message not found on active branch');
    return target;
  }

  queueInput(
    ctx: Context,
    id: string,
    text: string,
    mode: 'steer' | 'followUp',
    attachments?: Attachment[],
    options: Pick<InboxItem, 'model' | 'thinkingLevel'> & { fallback?: ModelChoice } = {},
  ) {
    this.sessions.assertAvailable(id);
    validateModelOptions(options.model, options.thinkingLevel);
    const log = this.sessions.log(id);
    const models = requireService(ctx, 'harnessModels');
    const choice = selectModel(models, {
      explicit: options.model,
      stored: log.projection().model,
      fallback: options.fallback,
      preferStored: true,
    });
    resolveThinking(models.capabilities(choice), options.thinkingLevel);
    return new Inbox(log).enqueue(mode, () => this.sessions.prepareInput(id, text, attachments), {
      model: choice,
      thinkingLevel: options.thinkingLevel,
    });
  }

  cancelQueue(id: string, itemId?: string) {
    this.sessions.assertAvailable(id);
    return new Inbox(this.sessions.log(id)).cancel('User cancelled', itemId);
  }

  private async prepareInput(
    ctx: Context,
    sessionId: string,
    model: ModelChoice,
    source: InputSource,
    text: string,
    images: ImageInput[],
    input: PreparedMessage,
    signal: AbortSignal,
  ) {
    const hooks = ctx.events.listeners('agent/prepare-input', scopeTarget(ctx));
    const context: InputContext = {
      sessionId,
      model,
      source,
      signal,
      original: { ...input, images },
      cwd: this.sessions.workspacePath(sessionId),
    };
    const initial: NativeUserMessage['content'] = [{ type: 'text', text }, ...images];
    const content = await applyTransforms(hooks, initial, context);
    validateNativeMessage({ role: 'user', content, timestamp: 0 });
    const preparedImages = typeof content === 'string' ? [] : content.filter((part) => part.type === 'image');
    if (
      preparedImages.length &&
      !requireService(ctx, 'harnessModels').capabilities(model)?.input.includes('image')
    )
      throw new Error(
        'The selected model does not support image input. Choose an image-capable model and retry.',
      );
    return {
      content,
      presentation: isDeepStrictEqual(images, preparedImages) ? input : { ...input, images },
      assertActive: () => {
        signal.throwIfAborted();
        this.sessions.assertAvailable(sessionId);
      },
    };
  }

  private async user(
    log: SessionLogPort,
    prepared: Awaited<ReturnType<SessionRun['prepareInput']>>,
    images: ImageInput[],
    emit: (event: AgentEvent) => void | Promise<void>,
    source: InputSource,
    delivery: {
      submissionId?: string;
      inboxId?: string;
      selection: { model: ModelChoice; thinkingLevel?: ThinkingLevel };
    },
    revision?: { parentId: string | null; expectedLeafId: string | null },
  ) {
    prepared.assertActive();
    const { content, presentation: input } = prepared;
    const event = {
      type: 'message',
      message: { role: 'user', content, timestamp: Date.now() },
      presentation: input,
      ...delivery,
    } as const;
    const entry = revision
      ? log.revise(event, revision.parentId, revision.expectedLeafId)
      : log.append(event);
    const displayed = input.userText ? [{ type: 'text', text: input.userText }, ...images] : images;
    await emit({
      type: 'user',
      source,
      model: delivery.selection.model,
      thinkingLevel: delivery.selection.thinkingLevel,
      id: entry.id,
      parentId: entry.parentId,
      revised: Boolean(revision),
      submissionId: delivery.submissionId,
      inboxId: delivery.inboxId,
      timestamp: event.message.timestamp,
      content: displayed,
      attachments: input.attachments,
    });
  }

  /** Never retry an unknown tool outcome after restart or provider failure. */
  private closeUnfinishedTools(log: SessionLogPort) {
    const pending = new Map<string, ToolCallPart>();
    for (const message of log.projection().contextMessages) {
      if (message.role === 'assistant')
        for (const part of message.content) if (part.type === 'toolCall') pending.set(part.id, part);
      if (message.role === 'toolResult') pending.delete(message.toolCallId);
    }
    if (!pending.size) return;
    const branch = new Set(log.branch().map(({ id }) => id));
    const executed = new Set(
      log
        .entries()
        .flatMap((entry) =>
          entry.type === 'tool-execution' && entry.parentId !== null && branch.has(entry.parentId)
            ? [entry.result.toolCallId]
            : [],
        ),
    );
    for (const call of pending.values())
      log.append({
        type: 'message',
        message: failedTool(
          call,
          executed.has(call.id)
            ? 'The tool completed without a recorded model-visible result. The tool was not retried.'
            : 'Execution was interrupted before a durable result was recorded. The tool was not retried.',
        ),
      });
  }

  async prompt(
    ctx: Context,
    record: SessionRecord,
    prompt: string,
    emit: (event: AgentEvent) => void | Promise<void>,
    options: SessionPrompt,
  ): Promise<string> {
    const { id } = record,
      {
        signal,
        choice,
        images = [],
        input = { userText: prompt, attachments: [] },
        source = 'user',
        thinkingLevel,
        revision,
        changed,
        submissionId,
        fallback,
        beginSubmission,
      } = options;
    let runLog: SessionLogPort | undefined;
    try {
      signal.throwIfAborted();
      const log = (runLog = this.sessions.log(id));
      let model: ModelChoice | undefined = log.projection(revision?.parentId).model;
      let capabilities: ReturnType<ModelCatalogPort['capabilities']>;
      let activeThinking: ThinkingLevel | undefined;
      if (!revision) this.closeUnfinishedTools(log);
      const inbox = new Inbox(log);
      const queuedSelection = (item: InboxItem) => {
        const models = requireService(ctx, 'harnessModels');
        const choice = item.model ?? log.projection().model ?? fallback;
        const chosen = choice && models.resolve(choice);
        if (!chosen) return { ok: false, failure: 'The queued model is no longer available' } as const;
        const nextCapabilities = models.capabilities(chosen);
        if (item.images.length && !nextCapabilities?.input.includes('image'))
          return { ok: false, failure: 'The selected model does not support queued image input' } as const;
        try {
          validateNativeMessage({
            role: 'user',
            content: [{ type: 'text', text: item.text }, ...item.images],
            timestamp: 0,
          });
          return {
            ok: true,
            chosen,
            nextCapabilities,
            level: resolveThinking(nextCapabilities, item.thinkingLevel, log.projection().thinkingLevel),
          } as const;
        } catch (error) {
          return { ok: false, failure: error instanceof Error ? error.message : String(error) } as const;
        }
      };
      const nextValid = (mode: InboxItem['mode']) => {
        for (const item of inbox.list()) {
          if (item.mode !== mode) continue;
          const selection = queuedSelection(item);
          if (!selection.ok) {
            log.append({ type: 'inbox-failed', inboxId: item.id, reason: selection.failure });
          } else return { item, ...selection };
        }
      };
      const deliver = async (mode: InboxItem['mode']) => {
        signal.throwIfAborted();
        for (let next = nextValid(mode); next; next = nextValid(mode)) {
          const { item, chosen, nextCapabilities, level } = next;
          let prepared: Awaited<ReturnType<SessionRun['prepareInput']>>;
          try {
            prepared = await this.prepareInput(
              ctx,
              id,
              chosen,
              'user',
              item.text,
              item.images,
              item.input ?? { userText: item.text, attachments: [] },
              signal,
            );
            prepared.assertActive();
          } catch (error) {
            signal.throwIfAborted();
            if (inbox.next(mode)?.id === item.id)
              log.append({
                type: 'inbox-failed',
                inboxId: item.id,
                reason: error instanceof Error ? error.message : String(error),
              });
            continue;
          }
          signal.throwIfAborted();
          if (inbox.next(mode)?.id !== item.id) continue;
          await this.user(log, prepared, item.images, emit, 'user', {
            submissionId,
            inboxId: item.id,
            selection: { model: chosen, thinkingLevel: level },
          });
          model = chosen;
          capabilities = nextCapabilities;
          activeThinking = level;
          return true;
        }
        return false;
      };
      // Drain recovered follow-ups as turns before committing the new manual input.
      let submitted = false;
      const submit = async () => {
        signal.throwIfAborted();
        beginSubmission?.();
        const previous = log.projection(revision?.parentId);
        const models = requireService(ctx, 'harnessModels');
        model = selectModel(models, {
          explicit: choice,
          stored: previous.model,
          fallback,
          preferStored: Boolean(record.parentId) || source !== 'user',
        });
        capabilities = models.capabilities(model);
        activeThinking = resolveThinking(capabilities, thinkingLevel, previous.thinkingLevel);
        const prepared = await this.prepareInput(ctx, id, model, source, prompt, images, input, signal);
        await this.user(
          log,
          prepared,
          images,
          emit,
          source,
          { submissionId, selection: { model, thinkingLevel: activeThinking } },
          revision,
        );
        if (record.titleSource === 'auto' && !previous.messages.some((item) => item.role === 'user'))
          this.sessions.rename(
            id,
            (input.userText || input.attachments[0]?.name || prompt).slice(0, 72),
            'auto',
          );
        if (revision) this.closeUnfinishedTools(log);
        submitted = true;
      };
      if (revision || !(await deliver('followUp'))) await submit();
      const answer = await requireService(ctx, 'harnessAgent').run(ctx, {
        signal,
        retry: (failure) => retryModel(ctx, { ...failure, sessionId: id }),
        onEvent: (event) => {
          if (event.type === 'request') {
            this.recordRequest(log, event.request);
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
            message: {
              id: assistant.id,
              parentId: assistant.parentId,
              role: 'assistant',
              content: result.content,
              timestamp: result.timestamp,
              error: result.stopReason === 'aborted' ? undefined : result.errorMessage,
            },
          });
        },
        afterTurn: async (calls) => {
          if (await deliver('steer')) return 'continue';
          if (calls.length) return;
          if (await deliver('followUp')) return 'continue';
          if (!submitted) {
            await submit();
            return 'restart';
          }
        },
        prepare: async (turn) => {
          if (!model) throw new Error('Configure a model before sending a message');
          const cwd = this.sessions.workspacePath(id);
          const step: StepContext = { sessionId: id, turn, phase: 'turn', cwd, model, signal };
          if (
            this.policy().autoCompact &&
            capabilities &&
            ctx
              .get('harnessCompaction')
              ?.shouldCompact(
                log.projection().contextMessages,
                Math.max(1024, capabilities.contextWindow * 0.8 - capabilities.maxTokens),
              )
          )
            await this.compactLog(ctx, id, log, signal, true);
          const current = log.projection();
          const executor: ToolExecutorPort = requireService(ctx, 'harnessToolExecutor');
          const tools = conversationTools(ctx, id);
          const advertisedTools = new Map(tools.map((tool) => [tool.name, tool]));
          const toolMetadata = tools.map(
            ({ name, description, parameters, label, promptSnippet, promptGuidelines }) => ({
              name,
              description,
              parameters,
              label,
              promptSnippet,
              promptGuidelines,
            }),
          );
          const promptService: PromptPort = requireService(ctx, 'harnessPrompt');
          const systemPrompt = await promptService.build({ sessionId: id, cwd, tools: toolMetadata, signal });
          const request = await this.prepareRequest(
            ctx,
            step,
            { systemPrompt, messages: current.contextMessages, thinkingLevel: current.thinkingLevel },
            (content) => {
              for (const [name, tool] of advertisedTools) if (!tool.available()) advertisedTools.delete(name);
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
              start(call) {
                emit({
                  type: 'tool',
                  id: call.id,
                  name: call.name,
                  state: 'running',
                  arguments: call.arguments,
                });
                if (signal.aborted) return 'Agent run cancelled';
                if (nextValid('steer')) return 'Skipped because a steering message arrived.';
                const tool = advertisedTools.get(call.name);
                if (tool && ctx.get('harnessToolPolicy')?.(id, tool) === false)
                  return 'Tool denied by conversation policy: ' + call.name;
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
              let originalContent: NativeToolMessage['content'] | undefined;
              if (!output.isError && hooks.length) {
                executionId = log.append({ type: 'tool-execution', result: output }).id;
                originalContent = output.content;
                try {
                  const resultContext = { ...step, signal: toolSignal, tool: call.name, callId: call.id };
                  const content = await applyTransforms(hooks, output.content, resultContext);
                  if (!isToolContent(content)) throw new Error('Invalid tool result content');
                  output = { ...output, content };
                } catch (error) {
                  output = {
                    ...failedTool(
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
              const entry =
                executionId && !transformError
                  ? log.append({
                      type: 'tool-accepted',
                      executionId,
                      contentDelta: contentDelta(
                        JSON.stringify(originalContent),
                        JSON.stringify(output.content),
                      ),
                    })
                  : log.append({ type: 'message', message: output, elapsedMs: output.elapsedMs });
              const details = output.details;
              if (!output.isError && typeof details?.changedPath === 'string') changed?.(details.changedPath);
              emit({
                type: 'tool',
                id: call.id,
                name: call.name,
                state: details?.approvalDenied === true ? 'denied' : output.isError ? 'error' : 'finished',
                arguments: call.arguments,
                content: output.content,
                entry: { id: entry.id, parentId: entry.parentId, timestamp: output.timestamp },
                elapsedMs: output.elapsedMs,
                approvalMs: typeof details?.approvalMs === 'number' ? details.approvalMs : undefined,
                sessionId: typeof details?.sessionId === 'string' ? details.sessionId : undefined,
                exitCode: typeof details?.exitCode === 'number' ? details.exitCode : undefined,
              });
              if (transformError) throw transformError;
            },
          };
        },
      });
      const text = textOf(answer);
      emit({ type: 'complete', text });
      return text;
    } finally {
      if (runLog && signal.aborted && !(signal.reason instanceof RunInterrupted))
        new Inbox(runLog).cancel('Run cancelled');
    }
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
      messages:
        Array.isArray(prepared.messages) && !capabilities?.input.includes('image')
          ? withoutImages(prepared.messages)
          : prepared.messages,
      model: context.model,
      signal: context.signal,
    };
  }

  private recordRequest(log: SessionLogPort, snapshot: Omit<LlmRequest, 'signal'>) {
    const projected = log.projection();
    const patch = messagePatch(projected.contextMessages, snapshot.messages);
    const schemaHashes =
      this.recordedSchemas.get(log) ??
      new Set(
        log
          .entries()
          .filter((entry) => entry.type === 'tool-schema')
          .map((entry) => entry.hash),
      );
    this.recordedSchemas.set(log, schemaHashes);
    const toolSchema =
      snapshot.tools === undefined
        ? undefined
        : createHash('sha256').update(JSON.stringify(snapshot.tools)).digest('hex');
    if (toolSchema && snapshot.tools && !schemaHashes.has(toolSchema)) {
      log.append({ type: 'tool-schema', hash: toolSchema, tools: snapshot.tools });
      schemaHashes.add(toolSchema);
    }
    log.append(
      {
        type: 'model-request',
        request: {
          model: snapshot.model,
          systemPrompt: snapshot.systemPrompt,
          thinkingLevel: snapshot.thinkingLevel,
          maxTokens: snapshot.maxTokens,
          toolSchema,
          ...(patch && { messagesPatch: patch }),
        },
      },
      projected.leafId,
    );
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
          const choice = projection.model;
          const model = choice && requireService(ctx, 'harnessModels').resolve(choice);
          if (!model) throw new DomainError('invalid_input', 'Configure a model before compacting');
          const context: StepContext = {
            sessionId: id,
            cwd: this.sessions.workspacePath(id),
            model,
            turn: 0,
            phase: 'compaction',
            signal,
          };
          const request = await this.prepareRequest(ctx, context, content);
          validateRequestSnapshot(request);
          this.recordRequest(log, request);
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
