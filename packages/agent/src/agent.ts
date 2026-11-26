import type { Context } from 'mini-harness/cordis';
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
    const { signal, task } = input;
    const llm = ctx.get('harnessLlm');
    if (!llm) throw new Error('Required service is unavailable: harnessLlm');
    const maxTurns = this.limit();
    const messages = 'request' in input ? [...input.request.messages] : undefined;
    const tools = new Map(('request' in input ? (input.tools ?? []) : []).map((tool) => [tool.name, tool]));
    const knownCalls = new Set<string>();
    for (let turn = 1; turn <= maxTurns; turn++) {
      signal.throwIfAborted();
      const step: AgentTurn = await ('prepare' in input
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
      const { request, executor, execution, deliver } = step;
      const requestCalls = validateRequestSnapshot(request);
      for (const id of requestCalls ?? []) knownCalls.add(id);
      task.update({ phase: 'model', turn });
      input.onEvent?.({ type: 'request', request });
      input.onEvent?.({ type: 'assistant-start' });
      const original = await requestModel(
        llm,
        { ...request, signal },
        {
          delta: (text) => input.onEvent?.({ type: 'delta', text }),
          retry: input.retry,
        },
      );
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
      input.onEvent?.({ type: 'assistant', message: result, diagnostic });
      if (failed(result))
        throw new Error(
          result.errorMessage || (signal.aborted ? 'Agent run cancelled' : 'Model request failed'),
        );
      signal.throwIfAborted();

      if (calls.length) {
        task.update({ phase: 'tools', turn });
        const pending = new Map(calls.map((call) => [call.id, call]));
        await executor.execute(calls, step.tools, {
          ...execution,
          signal,
          tasks: ctx.harnessTasks,
          ownerTask: task,
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
