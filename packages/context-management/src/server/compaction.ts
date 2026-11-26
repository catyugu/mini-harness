import {
  validateRequestSnapshot,
  type LlmRequest,
  type NativeMessage,
  type NativeUserMessage,
} from '@mini-harness/llm/api';
import type { Context } from 'mini-harness/cordis';
import { requestModel } from '@mini-harness/agent/model-request';
import { DomainError } from '@mini-harness/platform/errors';
import { scopeTarget } from '@mini-harness/plugin-api/scopes';
import { prepareModelMessages, selectModel } from '@mini-harness/models/selection';
import type {} from '@mini-harness/agent/events';
import type { SessionContext, SessionLogPort } from '@mini-harness/sessions/log-api';
import type { ContextOccupancy, ContextSettings } from '../shared/state.ts';
import type { TokenMeter } from './meter.ts';

const headings = ['Goal and constraints', 'Decisions', 'Files and diagnostics', 'Progress and next steps'];
const title = 'Summary of earlier conversation:\n';
const instruction = [
  'Write a continuation checkpoint for the next assistant. Summarize the preceding work and merge any older checkpoint, removing obsolete information.',
  'Keep important user instructions, identifiers, paths, commands and errors verbatim where practical. Preserve failed attempts and their resolutions.',
  'Keep original entry references for offloaded data needed to continue.',
  'Organize the checkpoint using these suggested headings:',
  ...headings.map((name) => '## ' + name),
  'Respond with the checkpoint only.',
].join('\n');

function user(content: string): NativeUserMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

/** Every group is either one message or an assistant call with all its tool results. */
function groups(messages: NativeMessage[]) {
  const groups: NativeMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'toolResult' && groups.length) groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  return groups;
}

export function splitPoint(
  projection: SessionContext,
  meter: TokenMeter,
  retain: number,
  available?: number,
) {
  const { contextMessages } = projection;
  const blocks = groups(contextMessages);
  let index = contextMessages.length;
  let kept = 0;
  if (!blocks.length) return 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    index -= block.length;
    kept += block.reduce((sum, message) => sum + meter.message(message), 0);
    if (kept >= retain) break;
  }
  if (available !== undefined && (kept >= available || index === 0)) return contextMessages.length;
  return index;
}

function transcript(group: NativeMessage[]) {
  return group
    .map(
      ({ role, content }) =>
        role +
        ': ' +
        (typeof content === 'string'
          ? content
          : content
              .map((part) => {
                switch (part.type) {
                  case 'text':
                    return part.text;
                  case 'thinking':
                    return part.thinking;
                  case 'image':
                    return '[Image retained in original conversation]';
                  case 'toolCall':
                    return part.name + ' ' + JSON.stringify(part.arguments);
                }
              })
              .join('\n')),
    )
    .join('\n\n');
}

export async function checkpoint(
  ctx: Context,
  log: SessionLogPort,
  request: LlmRequest,
  messages: NativeMessage[],
  settings: ContextSettings,
  desiredOutput: number,
  measure: (request: LlmRequest) => Promise<ContextOccupancy>,
  runId?: string,
) {
  const models = ctx.get('harnessModels');
  const llm = ctx.get('harnessLlm');
  if (!models || !llm) throw new DomainError('unavailable', 'Summary model service is unavailable');
  const { signal } = request;
  const { model } = selectModel(models, { explicit: settings.summaryModel ?? request.model });
  const capability = models.capabilities(model);
  const maxTokens = Math.floor(
    Math.min(
      capability?.maxTokens ?? desiredOutput,
      desiredOutput,
      capability?.contextWindow ? capability.contextWindow * settings.retainRatio : desiredOutput,
    ),
  );
  if (maxTokens <= 0)
    throw new DomainError('unavailable', 'There is no output budget for a continuation checkpoint');
  const base = {
    ...request,
    model,
    systemPrompt: 'Prepare a continuation checkpoint.',
    tools: undefined,
    thinkingLevel: undefined,
    maxTokens,
  };
  let prior: NativeUserMessage | undefined;

  async function assemble(segment: NativeMessage[]) {
    signal.throwIfAborted();
    const outgoing = {
      ...base,
      messages: prepareModelMessages(capability, [...(prior ? [prior] : []), ...segment, user(instruction)]),
    };
    const tally = await measure(outgoing);
    return { outgoing, fits: tally.budget === undefined || tally.total <= tally.budget };
  }

  async function summarize(outgoing: LlmRequest) {
    validateRequestSnapshot(outgoing);
    const recorded = log.recordRequest(outgoing, 'summary');
    const answer = await requestModel(llm, outgoing, {
      maxAttempts: 3,
      async retry(failure) {
        for (const { context, callback } of ctx.events.listeners('agent/model-retry', scopeTarget(ctx))) {
          const result = await context.fiber.run(
            (signal) => callback({ ...failure, sessionId: log.sessionId, signal }),
            signal,
          );
          if (result !== undefined) return result;
        }
      },
      attempt(metrics) {
        log.append({ type: 'model-attempt', requestId: recorded.id, summary: true, runId, ...metrics });
      },
    });
    signal.throwIfAborted();
    const summary = answer.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
      .trim();
    if (
      answer.errorMessage ||
      answer.stopReason === 'error' ||
      answer.stopReason === 'aborted' ||
      answer.stopReason === 'length' ||
      answer.content.some(({ type }) => type === 'toolCall') ||
      !summary
    )
      throw new DomainError(
        'unavailable',
        answer.errorMessage ?? 'Summary model returned an incomplete continuation checkpoint',
      );
    prior = user(title + summary);
  }

  const whole = await assemble(messages);
  if (whole.fits) {
    await summarize(whole.outgoing);
    return prior!;
  }
  // Oversized prefixes use a single textual representation for all segments.
  const text = transcript(messages);
  for (let from = 0; from < text.length; ) {
    let low = 1;
    let high = text.length - from;
    let end = from;
    let best: LlmRequest | undefined;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const result = await assemble([user(text.slice(from, from + size))]);
      if (result.fits) {
        end = from + size;
        best = result.outgoing;
        low = size + 1;
      } else high = size - 1;
    }
    if (!best) throw new DomainError('unavailable', 'Summary model has too little input capacity');
    await summarize(best);
    from = end;
  }
  if (!prior) throw new Error('No messages selected for compaction');
  return prior;
}
