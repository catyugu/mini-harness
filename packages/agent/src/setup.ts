import { sessionEvent } from '@mini-harness/plugin-api/instance';
import type {} from './events.js';
import { observe } from '@mini-harness/plugin-api/observations';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/plugin-api/scopes';
import type {} from '@mini-harness/models/api';
import type {} from '@mini-harness/llm/api';
import type {} from '@mini-harness/tools/api';
import type { Context } from 'mini-harness/cordis';
import { NativeAgent } from './agent.js';

export function setup(ctx: Context) {
  const { harnessRegistry: catalog, harnessScopes: scopes } = ctx;
  const agent = new NativeAgent(catalog, {
    models: (id) => scopes.require(`session:${id}`, 'harnessModels'),
    llm: (id) => scopes.require(`session:${id}`, 'harnessLlm'),
    tools: (id) => scopes.require(`session:${id}`, 'harnessTools'),
    prompt: (id) => scopes.require(`session:${id}`, 'harnessPrompt'),
    executor: (id) => scopes.require(`session:${id}`, 'harnessToolExecutor'),
    compaction: (id) => scopes.context(`session:${id}`).get('harnessCompaction'),
    policy: () => ctx.fiber.effectiveConfig as { maxTurns: number; autoCompact: boolean },
    observe: (event, signal) => observe(ctx, event, signal),
    inputHooks: (id) => ctx.events.listeners('agent/prepare-input', sessionEvent(ctx, id)),
    modelRequestHooks: (id) => ctx.events.listeners('agent/model-request', sessionEvent(ctx, id)),
    toolResultHooks: (id) => ctx.events.listeners('agent/tool-result', sessionEvent(ctx, id)),
    async retryModel(failure) {
      const { signal, ...input } = failure;
      for (const { context, callback } of ctx.events.listeners(
        'agent/model-retry',
        sessionEvent(ctx, failure.sessionId),
      )) {
        const retry = await context.fiber.run(
          (signal) => callback({ ...structuredClone(input), signal }),
          signal,
        );
        if (retry === undefined) continue;
        if (
          !retry ||
          typeof retry !== 'object' ||
          (retry.delayMs !== undefined &&
            (!Number.isFinite(retry.delayMs) || retry.delayMs < 0 || retry.delayMs > 30000))
        )
          throw new Error('Invalid model retry decision');
        return { delayMs: retry.delayMs };
      }
    },
  });
  ctx.provide('harnessAgent', agent);
}
