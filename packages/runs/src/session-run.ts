import { toolAvailable } from '@mini-harness/tools/execution';
import { displayMessage } from '@mini-harness/sessions/projection';
import { conversationTools } from './tool-selection.ts';
import type { Context } from 'mini-harness/cordis';
import type { TaskContext } from '@mini-harness/tasks/api';
import { scopeTarget } from '@mini-harness/plugin-api/scopes';
import type { AgentTurn } from '@mini-harness/agent/api';
import {
  modelRetry,
  type InputContext,
  type StepContext,
  type RequestPreparation,
} from '@mini-harness/agent/events';
import { DomainError } from '@mini-harness/platform/errors';
import { isDeepStrictEqual } from 'node:util';
import type { SessionCatalog, SessionLifecycle, SessionStore } from '@mini-harness/sessions/records';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelCatalogPort } from '@mini-harness/models/api';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import {
  isTextImageContent,
  validateNativeMessage,
  type NativeMessage,
  type NativeAssistantMessage,
  type NativeUserMessage,
  type ToolCallPart,
} from '@mini-harness/llm/api';
import { recordPublisher, type RunStreamEvent } from './shared/stream.ts';
import type { RecordPresentation } from '@mini-harness/sessions/display-record';
import type { MessageMode } from '@mini-harness/sessions/queue';
import type { SessionLogPort, InboxItem, SessionProjection } from '@mini-harness/sessions/log-api';
import { Inbox } from './inbox.ts';
import { applyTransforms, recoverRequest } from './transforms.ts';
import { toolFailure } from '@mini-harness/tools/execution';
import {
  prepareModelMessages,
  resolveThinking,
  selectModel,
  assertImageInput,
} from '@mini-harness/models/selection';

function requireService<K extends keyof Context & string>(ctx: Context, name: K): NonNullable<Context[K]> {
  const value = ctx.get(name);
  if (value == null) throw new DomainError('unavailable', 'Required service is unavailable: ' + name);
  return value;
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
  revision?: Revision;

}

type Revision = Omit<InboxItem, 'id' | 'mode'> & {
  mode: 'revision';
  parentId: string | null;
  expectedLeafId: string | null;
};

type Input = InboxItem | Revision;

export function selectInputModel(
  models: ModelCatalogPort,
  item: Pick<Input, 'model' | 'thinkingLevel' | 'mode' | 'origin'>,
  previous: Pick<SessionProjection, 'model' | 'thinkingLevel'>,
  fallback: ModelChoice | undefined,
  parentId: string | null,
) {
  const choices = item.model
    ? [item.model]
    : parentId || item.mode === 'steer' || item.mode === 'revision' || item.origin.source !== 'user'
      ? [previous.model, fallback]
      : [fallback, previous.model];
  const selected = selectModel(
    models,
    choices,
    item.model
      ? 'Unknown model: ' + item.model.provider + (item.model.id === undefined ? '' : '/' + item.model.id)
      : undefined,
  );
  return {
    ...selected,
    thinkingLevel: resolveThinking(selected.capabilities, item.thinkingLevel, previous.thinkingLevel),
  };
}

export class SessionRun {
  constructor(
    private readonly sessions: Pick<SessionCatalog, 'workspacePath'> &
      Pick<SessionLifecycle, 'assertAvailable' | 'rename'> &
      Pick<SessionStore, 'log'>,
  ) {}

  /** Never retry an unknown tool outcome after restart or provider failure. */
  closeUnfinishedTools(log: SessionLogPort, cancelled = false) {
    const pending = new Map<string, ToolCallPart>();
    for (const message of log.context().contextMessages) {
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
    emit: (event: RunStreamEvent) => void | Promise<void>,
    options: SessionPrompt,
  ): Promise<string> {
    const { id } = record;
    const { signal, task, revision, fallback } = options;
    const submissionId = task.id;
    signal.throwIfAborted();
    const log = this.sessions.log(id);
    if (!revision) this.closeUnfinishedTools(log);
    const inbox = new Inbox(log);

    const selection = (item: Input, previous = log.context()) => {
      const models = requireService(ctx, 'harnessModels');
      const selected = selectInputModel(models, item, previous, fallback, record.parentId);
      assertImageInput(selected.capabilities, item.images.length);
      validateNativeMessage({
        role: 'user',
        content: [{ type: 'text', text: item.text }, ...item.images],
        timestamp: 0,
      });
      return selected;
    };

    const prepare = async (item: Input, selected: ReturnType<typeof selection>) => {
      const { input: presentation, origin } = item;
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
      const preparedImages = content.filter((part) => part.type === 'image');
      assertImageInput(selected.capabilities, preparedImages.length);
      signal.throwIfAborted();
      this.sessions.assertAvailable(id);
      return {
        selection: { model: selected.model, thinkingLevel: selected.thinkingLevel },
        presentation: isDeepStrictEqual(item.images, preparedImages)
          ? presentation
          : { ...presentation, images: item.images },
        content,
      };
    };

    const commit = async (item: Input, prepared: Awaited<ReturnType<typeof prepare>>) => {
      signal.throwIfAborted();
      this.sessions.assertAvailable(id);
      const edit = item.mode === 'revision' ? item : undefined;
      const { origin } = item;
      const event = {
        type: 'message',
        message: { role: 'user', content: prepared.content, timestamp: Date.now() },
        presentation: prepared.presentation,
        selection: prepared.selection,
        submissionId,
        inboxId: item.mode === 'revision' ? undefined : item.id,
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
        const title = item.input.userText || item.input.attachments[0]?.name || item.text;
        this.sessions.rename(id, title.slice(0, 72), 'auto');
      }
    };
    const deliver = (modes: MessageMode[], requireInput = false) =>
      inbox.deliver(
        modes,
        signal,
        (item) => prepare(item, selection(item)),
        commit,
        requireInput,
      );
    if (revision) {
      await commit(revision, await prepare(revision, selection(revision, log.context(revision.parentId))));
      this.closeUnfinishedTools(log);
    } else {
      if (!(await deliver(['interrupt', 'steer', 'queue'], true))) return '';
      while (await deliver(['interrupt'])) {
        // Coalesce messages accepted during the same interruption before requesting a model turn.
      }
    }
    let requestId: string | undefined;
    let modelStep = 0;
    const publisher = recordPublisher(emit);
    const target = scopeTarget(ctx);
    const toolTransforms = () => ctx.events.listeners('agent/tool-result', target);
    const prepareTurn = async (turn: number): Promise<AgentTurn> => {
      const current = log.context();
      const model = current.model;
      if (!model) throw new Error('Configure a model before sending a message');
      const cwd = this.sessions.workspacePath(id);
      const step: StepContext = { sessionId: id, turn, cwd, model, signal };
      const executor = requireService(ctx, 'harnessToolExecutor');
      const capabilities = selectModel(requireService(ctx, 'harnessModels'), [model]).capabilities;
      const projectMessages = async (messages: NativeMessage[], requestSignal: AbortSignal) => {
        const hooks = ctx.events.listeners('agent/project-messages', target);
        const projected = await applyTransforms(hooks, hooks.length ? structuredClone(messages) : messages, {
          ...step,
          signal: requestSignal,
        });
        return prepareModelMessages(capabilities, projected);
      };
      const tools = conversationTools(ctx, id);
      const metadata = tools.map(({ name, description, parameters, label, metadata }) => ({
        name,
        description,
        parameters,
        label,
        metadata,
      }));
      const systemPrompt =
        (await ctx.get('harnessPrompt')?.build({ sessionId: id, cwd, tools: metadata, signal })) ?? '';
      const messages = await projectMessages(log.context().contextMessages, signal);
      const advertisedTools = new Map(tools.filter(toolAvailable).map((tool) => [tool.name, tool]));
      const schemas = metadata
        .filter(({ name }) => advertisedTools.has(name))
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
      const preparation: RequestPreparation = {
        ...step,
        context: ctx,
        runId: submissionId,
        projectMessages,
      };
      const request = await applyTransforms(
        ctx.events.listeners('agent/prepare-request', target),
        {
          ...executor.present(systemPrompt, schemas, step),
          model,
          messages,
          thinkingLevel: current.thinkingLevel,
          signal,
        },
        preparation,
      );
      resolveThinking(capabilities, request.thinkingLevel);
      return {
        request,
        recover: (request, failure) =>
          recoverRequest(ctx.events.listeners('agent/recover-request', target), request, {
            ...preparation,
            failure,
          }),
        executor,
        tools: advertisedTools,
        execution: {
          executionId: task.id,
          async waitFor(id, signal) {
            await task.waitFor(id, signal);
          },
          start(call) {
            if (signal.aborted) return { state: 'skipped', reason: 'Agent run cancelled' };
            if (inbox.hasValid('steer', selection))
              return { state: 'skipped', reason: 'Skipped because a steering message arrived.' };
            const tool = advertisedTools.get(call.name);
            if (tool && ctx.get('harnessToolPolicy')?.(id, tool) === false)
              return { state: 'denied', reason: 'Tool denied by conversation policy: ' + call.name };
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
            const transform = toolTransforms().length > 0;
            if (value.state === undefined && transform) return;
            emit({
              type: 'tool',
              id: call.id,
              name: call.name,
              state: value.state ?? 'running',
              arguments: call.arguments,
              content: transform ? undefined : value.content,
            });
          },
          write(call, text, channel) {
            emit({ type: 'tool-output', id: call.id, channel, text });
          },
        },
        async deliver(output, toolSignal, call) {
          const hooks = toolTransforms();
          let executionId: string | undefined;
          let transformError: Error | undefined;
          if (output.state === 'finished' && hooks.length) {
            executionId = log.append({ type: 'tool-execution', result: output }).id;
            try {
              const resultContext = { ...step, signal: toolSignal, tool: call.name, callId: call.id };
              const content = await applyTransforms(hooks, output.content, resultContext);
              if (!isTextImageContent(content)) throw new Error('Invalid tool result content');
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
          emit({
            type: 'tool-end',
            message: displayMessage(entry, output, submissionId, call.arguments),
          });
          if (transformError) throw transformError;
        },
      };
    };
    const answer = await requireService(ctx, 'harnessAgent')
      .run(ctx, {
        signal,
        retry: modelRetry(ctx, id),
        onEvent: (event) => {
          const displays: RecordPresentation[] = [];
          for (const { callback } of ctx.events.listeners('agent/records', target)) {
            const contribution = callback(event, publisher);
            if (!contribution?.length) continue;
            if (event.type !== 'assistant')
              throw new Error('Record presentations require a committed assistant message');
            displays.push(...contribution);
          }
          if (event.type === 'thinking') return;
          if (event.type === 'phase') {
            if (event.phase === 'model') modelStep = event.turn;
            task.update({ phase: event.phase, turn: event.turn });
            return;
          }
          if (event.type === 'request') {
            requestId = log.recordRequest(event.request).id;
            return;
          }
          if (event.type === 'model-attempt') {
            if (!requestId) throw new Error('Missing model request for attempt');
            log.append({
              type: 'model-attempt',
              requestId,
              runId: submissionId,
              step: modelStep,
              ...event.metrics,
            });
            return;
          }
          if (event.type !== 'assistant') {
            emit(event);
            return;
          }
          const { diagnostic, message: result } = event;
          if (diagnostic) log.append({ type: 'diagnostic', code: diagnostic.code, data: diagnostic.message });
          const assistant = log.append({
            type: 'message',
            message: result,
            ...(displays.length && { displays }),
          });
          emit({
            type: 'assistant-end',
            message: displayMessage(assistant, result, submissionId),
          });
        },
        afterTurn: async () => {
          if (await deliver(['steer'])) return 'continue';
        },
        prepare: prepareTurn,
      })
      .catch((error) => {
        if (signal.aborted) this.closeUnfinishedTools(log, true);
        throw error;
      });
    const text = textOf(answer);
    emit({ type: 'complete', text });
    return text;
  }
}
