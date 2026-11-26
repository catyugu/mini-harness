import {
  validateRequestSnapshot,
  type LlmRequest,
  type NativeMessage,
  type NativeUserMessage,
} from '@mini-harness/llm/api';
import { selectModel } from '@mini-harness/models/selection';
import type { ContextRequest } from '@mini-harness/runs/context-management';
import type { SessionContext } from '@mini-harness/sessions/log-api';
import type { ContextOccupancy, ContextSettings } from '../shared/state.ts';
import type { TokenMeter } from './meter.ts';

const headings = ['Goal and constraints', 'Decisions', 'Files and diagnostics', 'Progress and next steps'];
const title = 'Summary of earlier conversation:\n';
const instruction = [
  'Write a continuation checkpoint for the next assistant. Summarize the preceding work and merge any older checkpoint, removing obsolete information.',
  'Keep important user instructions, identifiers, paths, commands and errors verbatim where practical. Preserve failed attempts and their resolutions.',
  'Use Markdown headings exactly as follows and give concise factual details under each:',
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

export function splitPoint(projection: SessionContext, meter: TokenMeter, retain: number, force: boolean) {
  const { contextMessages, contextRevisions } = projection;
  const blocks = groups(contextMessages);
  let index = contextMessages.length;
  let kept = 0;
  if (!blocks.length) return 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    index -= block.length;
    kept += block.reduce(
      (sum, message, offset) => sum + meter.message(message, contextRevisions[index + offset]),
      0,
    );
    if (kept >= retain) break;
  }
  if (index > 0 && !force && index === 1 && isCheckpoint(contextMessages[0])) return 0;
  if (index === 0 && force && contextMessages.length) return contextMessages.length;
  return index;
}

function isCheckpoint(message: NativeMessage) {
  return message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(title);
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

function validSummary(text: string) {
  return (
    text.trim() && headings.every((heading) => new RegExp('^#{1,6} ' + heading + '\\s*$', 'm').test(text))
  );
}

export async function checkpoint(
  input: ContextRequest,
  request: LlmRequest,
  messages: NativeMessage[],
  settings: ContextSettings,
  desiredOutput: number,
  measure: (request: LlmRequest) => Promise<ContextOccupancy>,
) {
  const models = input.ctx.get('harnessModels');
  if (!models) throw new Error('No model catalog is available to prepare a checkpoint');
  const { model } = selectModel(models, { explicit: settings.summaryModel ?? request.model });
  const capability = models.capabilities(model);
  const window = capability?.contextWindow ?? 32000;
  const maxTokens = Math.floor(Math.min(capability?.maxTokens ?? 4096, window / 6, desiredOutput));
  if (maxTokens < 32) throw new Error('There is no output budget for a continuation checkpoint');
  const base = { ...request, model, thinkingLevel: undefined, maxTokens };
  const short = { ...base, systemPrompt: 'Prepare a continuation checkpoint.', tools: undefined };
  let prior: NativeUserMessage | undefined;
  let useShort = false;
  let attempts = 0;
  const limit = 12;

  async function assemble(segment: NativeMessage[]) {
    input.signal.throwIfAborted();
    const outgoing = await input.assembleSummary({
      ...(useShort ? short : base),
      messages: [...(prior ? [prior] : []), ...segment, user(instruction)],
    });
    const tally = await measure(outgoing);
    return { outgoing, fits: tally.total <= (tally.budget ?? window - maxTokens) };
  }

  async function summarize(segment: NativeMessage[]) {
    if (++attempts > limit) throw new Error('Summary model requires too many segments for this context');
    const { outgoing, fits } = await assemble(segment);
    if (!fits) throw new Error('Summary model has too little input capacity for this segment');
    validateRequestSnapshot(outgoing);
    const answer = await input.summarize(outgoing);
    input.signal.throwIfAborted();
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
      !validSummary(summary)
    )
      throw new Error(answer.errorMessage ?? 'Summary model returned an incomplete continuation checkpoint');
    prior = user(title + summary);
  }

  const pending = groups(messages);
  if ((await assemble(messages)).fits) {
    await summarize(messages);
    return prior!;
  }
  if ((await assemble([user('A short segment')])).fits === false) useShort = true;
  let segment: NativeMessage[] = [];
  for (const group of pending) {
    const combined = [...segment, ...group];
    if ((await assemble(combined)).fits) {
      segment = combined;
      continue;
    }
    if (segment.length) await summarize(segment);
    segment = [];
    if ((await assemble(group)).fits) {
      segment = group;
      continue;
    }
    useShort = true;
    if ((await assemble(group)).fits) {
      segment = group;
      continue;
    }
    // Only an indivisible exchange that exceeds the summary window uses a text transcript.
    const text = transcript(group);
    let offset = 0;
    let length = Math.max(64, Math.floor(window / 2));
    while (offset < text.length) {
      const piece = user(text.slice(offset, offset + length));
      if ((await assemble([piece])).fits) {
        await summarize([piece]);
        offset += length;
      } else {
        length = Math.floor(length / 2);
        if (length < 32) throw new Error('Summary model has too little input capacity');
      }
    }
  }
  if (segment.length) await summarize(segment);
  if (!prior) throw new Error('No messages selected for compaction');
  return prior;
}
