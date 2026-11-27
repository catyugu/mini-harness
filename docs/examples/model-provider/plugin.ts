import type { Context } from 'mini-harness/cordis';
import type { LlmAdapter } from 'mini-harness/llm';
import type { ModelChoice } from 'mini-harness/llm/vocabulary';
import type { ModelSource } from 'mini-harness/models';
import type { ProviderModel } from 'mini-harness/models/catalog';

export const inject = ['harnessModels'];

const choice: ModelChoice = { provider: 'example', id: 'echo' };
const model: ProviderModel = {
  id: choice.id,
  name: 'Example echo',
  input: ['text'],
  contextWindow: 8192,
  maxTokens: 1024,
  reasoning: false,
  thinkingLevels: ['off'],
};
const accepts = (candidate: Readonly<ModelChoice>) =>
  candidate.provider === choice.provider && candidate.id === choice.id;

const source: ModelSource = {
  list: () => [{ ...choice, name: model.name, configured: true, thinkingLevels: ['off'], input: ['text'] }],
  resolve: (candidate) => (accepts(candidate) ? { model: choice, capabilities: model } : undefined),
};

// A deterministic local adapter makes the complete registration example runnable without credentials.
const adapter: LlmAdapter = {
  accepts,
  async *stream(request) {
    request.signal.throwIfAborted();
    const input = [...request.messages].reverse().find((message) => message.role === 'user')?.content;
    const text =
      'Echo: ' +
      (input ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    yield { type: 'text-delta', text };
    request.signal.throwIfAborted();
    yield {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        provider: choice.provider,
        model: choice.id,
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    };
  },
};

export function apply(ctx: Context) {
  ctx.effect(() => ctx.harnessModels.register(source, adapter));
}
