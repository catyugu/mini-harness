import type {
  LlmPort,
  LlmRequest,
  NativeAssistantMessage,
  NativeMessage,
  NativeUserMessage,
} from '@mini-harness/llm/api';
import type { ProviderModel } from '@mini-harness/models/catalog';
import { prepareModelMessages } from '@mini-harness/models/selection';
import { DomainError } from '@mini-harness/platform/errors';
import { measure, messageTokens, tokenPrefix, totalTokens } from './meter.ts';

const title = 'Summary of earlier conversation:\n';
const instruction =
  'Write a continuation checkpoint for the next assistant. Merge earlier checkpoints and preserve user constraints, decisions, identifiers, diagnostics, source references, progress and next steps. Respond with the checkpoint only.';
const user = (content: string): NativeUserMessage => ({
  role: 'user',
  content: [{ type: 'text', text: content }],
  timestamp: Date.now(),
});

/** Retain whole recent exchange units within the retention budget. */
export function splitPoint(messages: NativeMessage[], retain: number) {
  let cut = messages.length,
    kept = 0;
  while (cut > 0 && kept < retain) {
    let start = cut - 1;
    while (start > 0 && messages[start].role === 'toolResult') start--;
    const cost = messages.slice(start, cut).reduce((sum, message) => sum + messageTokens(message), 0);
    cut = start;
    kept += cost;
  }
  return cut;
}

function transcript(messages: NativeMessage[]) {
  return messages
    .map(
      ({ role, content }) =>
        role +
        ': ' +
        content
          .map((part) => {
            switch (part.type) {
              case 'text':
                return part.text;
              case 'thinking':
                return part.thinking;
              case 'image':
                return '[Image in original conversation]';
              case 'toolCall':
                return part.name + ' ' + JSON.stringify(part.arguments);
            }
          })
          .join('\n'),
    )
    .join('\n\n');
}

export async function checkpoint(
  request: LlmRequest,
  capability: ProviderModel,
  llm: Pick<LlmPort, 'countInputTokens'>,
  messages: NativeMessage[],
  execute: (request: LlmRequest) => Promise<NativeAssistantMessage>,
  calibrate: () => number,
) {
  const assemble = (segment: NativeMessage[]) =>
    measure(
      {
        ...request,
        messages: prepareModelMessages(capability, [...segment, user(instruction)]),
      },
      capability,
      llm,
      calibrate,
    );
  async function summarize(outgoing: Awaited<ReturnType<typeof assemble>>) {
    const answer = await execute(outgoing);
    request.signal.throwIfAborted();
    const summary = answer.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
      .trim();
    if (answer.errorMessage || answer.stopReason === 'error' || answer.stopReason === 'aborted')
      throw new DomainError('unavailable', answer.errorMessage ?? 'Summary model request failed');
    if (answer.stopReason === 'length')
      throw new DomainError(
        'unavailable',
        'Summary model reached its output limit before completing the checkpoint',
      );
    if (answer.stopReason === 'toolUse' || answer.content.some(({ type }) => type === 'toolCall'))
      throw new DomainError('unavailable', 'Summary model returned a tool call instead of a checkpoint');
    if (!summary) throw new DomainError('unavailable', 'Summary model returned no checkpoint text');
    return user(title + summary);
  }
  const whole = await assemble(messages);
  if (totalTokens(whole.inputMeasurement) <= whole.inputMeasurement.budget) return summarize(whole);
  const text = transcript(messages);
  let prior: ReturnType<typeof user> | undefined;
  for (let from = 0; from < text.length; ) {
    const prefix = prior ? [prior] : [];
    const overhead = (await assemble(prefix)).inputMeasurement;
    const scale = overhead.estimated ? calibrate() : 1;
    const length = tokenPrefix(text.slice(from), (overhead.budget - totalTokens(overhead)) / scale - 4);
    if (!length) throw new DomainError('unavailable', 'Summary model has too little input capacity');
    const outgoing = await assemble([...prefix, user(text.slice(from, from + length))]);
    if (totalTokens(outgoing.inputMeasurement) > outgoing.inputMeasurement.budget)
      throw new DomainError('unavailable', 'Summary segment exceeds model input capacity');
    prior = await summarize(outgoing);
    from += length;
  }
  if (!prior) throw new Error('Empty checkpoint transcript');
  return prior;
}
