import type { Context } from 'mini-harness/cordis';
import { isDeepStrictEqual } from 'node:util';
import {
  assistantFailed,
  validateNativeMessage,
  validateRequestSnapshot,
  type ToolCallPart,
} from '@mini-harness/llm/api';
import type { AgentEvent, AgentPort, AgentRun } from './api.ts';
import { requestModel } from './model-request.ts';

export class AgentLoop implements AgentPort {
  constructor(private readonly limit: () => number) {}

  async run(ctx: Context, input: AgentRun) {
    const { signal } = input;
    const llm = ctx.get('harnessLlm');
    if (!llm) throw new Error('Required service is unavailable: harnessLlm');
    const maxTurns = this.limit();
    const knownCalls = new Set<string>();
    for (let turn = 1; turn <= maxTurns; turn++) {
      signal.throwIfAborted();
      let step = await input.prepare(turn);
      input.onEvent?.({ type: 'phase', phase: 'model', turn });
      input.onEvent?.({ type: 'assistant-start' });
      const original = await requestModel(
        llm,
        { ...step.request, signal },
        {
          request(request) {
            for (const id of validateRequestSnapshot(request) ?? []) knownCalls.add(id);
            input.onEvent?.({ type: 'request', request });
          },
          delta: (text) => input.onEvent?.({ type: 'delta', text }),
          thinking: (text) => input.onEvent?.({ type: 'thinking', text }),
          attempt: (metrics) => input.onEvent?.({ type: 'model-attempt', metrics }),
          retry: input.retry,
          async recover(request, failure) {
            const next = await step.recover?.(request, failure);
            if (!next) return;
            step = { ...step, request: next };
            input.onEvent?.({ type: 'assistant-start' });
            return { ...next, signal };
          },
        },
      );
      const { request, executor, execution, deliver } = step;
      let result = original;
      let diagnostic: Extract<AgentEvent, { type: 'assistant' }>['diagnostic'];
      if (!assistantFailed(original)) {
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
      input.onEvent?.({ type: 'assistant', message: result, diagnostic });
      if (assistantFailed(result)) {
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
          },
        });
        signal.throwIfAborted();
        if (pending.size) throw new Error('Tool executor omitted results: ' + [...pending.keys()].join(', '));
      }
      signal.throwIfAborted();
      const next = await input.afterTurn?.(calls);
      if (next === 'restart') turn = 0;
      if (!next && !calls.length) return result;
    }
    throw new Error('Agent reached the configured turn limit (' + maxTurns + ')');
  }
}
