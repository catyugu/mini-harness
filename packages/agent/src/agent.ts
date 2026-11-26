import type { Context } from 'mini-harness/cordis';
import { randomUUID } from 'node:crypto';
import type { RecordPresentation } from '@mini-harness/plugin-api/timeline';
import { isDeepStrictEqual } from 'node:util';
import {
  validateNativeMessage,
  validateRequestSnapshot,
  type NativeAssistantMessage,
  type ToolCallPart,
} from '@mini-harness/llm/api';
import type { AgentEvent, AgentPort, AgentRun, AgentTurn } from './api.ts';
import { requestModel } from './model-request.ts';

export class AgentLoop implements AgentPort {
  constructor(private readonly limit: () => number) {}

  async run(ctx: Context, input: AgentRun) {
    const { signal } = input;
    const llm = ctx.get('harnessLlm');
    if (!llm) throw new Error('Required service is unavailable: harnessLlm');
    const maxTurns = this.limit();
    const messages = 'request' in input ? [...input.request.messages] : undefined;
    const tools = new Map(('request' in input ? (input.tools ?? []) : []).map((tool) => [tool.name, tool]));
    const knownCalls = new Set<string>();
    for (let turn = 1; turn <= maxTurns; turn++) {
      signal.throwIfAborted();
      let step: AgentTurn | undefined = await ('prepare' in input
        ? input.prepare(turn)
        : (() => {
            const executor = ctx.get('harnessToolExecutor');
            if (!executor) throw new Error('Required service is unavailable: harnessToolExecutor');
            const request = { ...input.request, messages: messages! };
            const schemas = [...tools.values()].map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            }));
            return {
              request: {
                ...request,
                ...executor.present(request, schemas, { model: request.model, signal, turn }),
              },
              executor,
              tools,
            };
          })());
      if (!step) throw new Error('The step was not prepared');
      input.onEvent?.({ type: 'phase', phase: 'model', turn });
      input.onEvent?.({ type: 'assistant-start' });
      const reasoningId = randomUUID();
      const owner = { pluginId: 'core:agent', instanceId: 'core:agent' };
      const kind = 'reasoning';
      const title = 'Reasoning';
      let reasoningOpened = false;
      const original = await requestModel(
        llm,
        { ...step.request, signal },
        {
          request(request) {
            for (const id of validateRequestSnapshot(request) ?? []) knownCalls.add(id);
            input.onEvent?.({ type: 'request', request });
          },
          delta: (text) => input.onEvent?.({ type: 'delta', text }),
          thinking(text) {
            if (!reasoningOpened) {
              reasoningOpened = true;
              input.onEvent?.({ type: 'record-update', operation: 'set', record: { type: 'record', id: reasoningId, plugin: owner.pluginId, instanceId: owner.instanceId, kind, title } });
            }
            input.onEvent?.({ type: 'record-update', operation: 'append', id: reasoningId, channel: 'text', text });
          },
          attempt: (metrics) => input.onEvent?.({ type: 'model-attempt', metrics }),
          retry: input.retry,
          async recover(failure) {
            if (!('prepare' in input)) return;
            const next = await input.prepare(turn, failure);
            if (!next) return;
            step = next;
            input.onEvent?.({ type: 'assistant-start' });
            return { ...next.request, signal };
          },
        },
      );
      const { request, executor, execution, deliver } = step;
      let result = original;
      let diagnostic: Extract<AgentEvent, { type: 'assistant' }>['diagnostic'];
      if (!failed(original)) {
        result = executor.interpret(original, { model: request.model, turn, signal });
        if (!isDeepStrictEqual(result, original))
          diagnostic = { code: 'executor-response', message: original };
      }
      const calls = result.content.filter((part): part is ToolCallPart => part.type === 'toolCall');
      for (const { id } of calls) {
        if (typeof id !== 'string' || !id || id.length > 256 || knownCalls.has(id)) {
          diagnostic = { code: 'invalid-tool-calls', message: result };
          result = {
            ...result,
            content: result.content.filter((part) => part.type !== 'toolCall'),
            stopReason: 'error',
            errorMessage: 'The model returned duplicate or invalid tool call IDs; no tools were executed.',
          };
          break;
        }
        knownCalls.add(id);
      }
      validateNativeMessage(result);
      messages?.push(result);
      const display: RecordPresentation | undefined = result.content.some((part) => part.type === 'thinking' && part.thinking && !part.redacted)
        ? { owner, kind, title, id: reasoningId, source: ['message', 'content'] }
        : undefined;
      if (reasoningOpened && !display) input.onEvent?.({ type: 'record-update', operation: 'remove', id: reasoningId });
      input.onEvent?.({ type: 'assistant', message: result, diagnostic, display });
      if (failed(result)) {
        signal.throwIfAborted();
        throw new Error(result.errorMessage || 'Model request failed');
      }

      if (calls.length) {
        input.onEvent?.({ type: 'phase', phase: 'tools', turn });
        const pending = new Map(calls.map((call) => [call.id, call]));
        await executor.execute(calls, step.tools, {
          ...execution,
          signal,
          async deliver(result, workSignal) {
            const call = pending.get(result.toolCallId);
            if (!call || call.name !== result.toolName)
              throw new Error('Unmatched tool executor result: ' + result.toolCallId);
            validateNativeMessage(result);
            pending.delete(call.id);
            await deliver?.(result, workSignal, call);
            messages?.push(result);
          },
        });
        signal.throwIfAborted();
        if (pending.size) throw new Error('Tool executor omitted results: ' + [...pending.keys()].join(', '));
      }
      signal.throwIfAborted();
      const next = 'prepare' in input && (await input.afterTurn?.(calls));
      if (next === 'restart') turn = 0;
      if (!next && !calls.length) return result;
    }
    throw new Error('Agent reached the configured turn limit (' + maxTurns + ')');
  }
}

function failed(message: NativeAssistantMessage) {
  return Boolean(message.errorMessage || message.stopReason === 'error' || message.stopReason === 'aborted');
}
