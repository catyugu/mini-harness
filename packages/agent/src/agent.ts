import type { Context } from 'mini-harness/cordis';
import { isDeepStrictEqual } from 'node:util';
import {
  validateNativeMessage,
  validateRequestSnapshot,
  type NativeAssistantMessage,
  type ToolCallPart,
} from '@mini-harness/llm/api';
import type { AgentPort, AgentRun } from './api.ts';
import type { StepContext } from './events.ts';
import { requestModel } from './model-request.ts';

export class AgentLoop implements AgentPort {
  constructor(private readonly limit: () => number) {}

  async run(ctx: Context, input: AgentRun) {
    const { signal } = input;
    const llm = ctx.get('harnessLlm');
    if (!llm) throw new Error('Required service is unavailable: harnessLlm');
    const maxTurns = this.limit();
    const messages = [...(input.messages ?? [])];
    for (let turn = 1; turn <= maxTurns; turn++) {
      signal.throwIfAborted();
      const { request, executor, tools, context, history, execution, deliver } = await input.prepare(
        turn,
        messages,
      );
      const step: StepContext = { ...context, model: request.model, turn, phase: 'turn', signal };
      validateRequestSnapshot(request);
      input.assistantStart?.();
      const original = await requestModel(
        llm,
        { ...request, signal },
        {
          delta: input.delta,
          ended: input.attemptEnded,
          retry: input.retry,
        },
      );
      let result = original;
      let diagnostic: Parameters<NonNullable<AgentRun['assistant']>>[1];
      if (!failed(original)) {
        result = executor.interpret(structuredClone(original), step);
        if (!isDeepStrictEqual(result, original))
          diagnostic = { code: 'executor-response', message: original };
      }
      const knownCalls = new Set(
        [...(history ?? messages), ...request.messages].flatMap((message) =>
          message.role === 'assistant'
            ? message.content.filter((part) => part.type === 'toolCall').map((part) => part.id)
            : [],
        ),
      );
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
      messages.push(result);
      input.assistant?.(result, diagnostic);
      if (failed(result))
        throw new Error(
          result.errorMessage || (signal.aborted ? 'Agent run cancelled' : 'Model request failed'),
        );
      signal.throwIfAborted();

      if (calls.length) {
        const pending = new Map(calls.map((call) => [call.id, call]));
        await executor.execute(calls, tools, {
          cwd: context?.cwd,
          signal,
          start: execution?.start ?? (() => undefined),
          phase: execution?.phase ?? (() => {}),
          update: execution?.update ?? (() => {}),
          async deliver(result, workSignal) {
            const call = pending.get(result.toolCallId);
            if (!call || call.name !== result.toolName)
              throw new Error('Unmatched tool executor result: ' + result.toolCallId);
            validateNativeMessage(result);
            pending.delete(call.id);
            messages.push(deliver ? await deliver(result, workSignal, call) : result);
          },
        });
        signal.throwIfAborted();
        if (pending.size) throw new Error('Tool executor omitted results: ' + [...pending.keys()].join(', '));
      }
      const next = await input.afterTurn?.(calls);
      if (next === 'restart') turn = 0;
      if (!next && !calls.length) return result;
    }
    throw new Error('Agent reached the configured turn limit (' + maxTurns + ')');
  }
}

function failed(message: NativeAssistantMessage) {
  return Boolean(message.errorMessage || message.stopReason === 'error' || message.stopReason === 'aborted');
}
