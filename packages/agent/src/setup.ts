import type {} from '@mini-harness/kernel/observations';
import { DomainError } from '@mini-harness/platform/errors';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/kernel/mutation-api';
import type {} from '@mini-harness/models/api';
import type {} from '@mini-harness/llm/api';
import type {} from '@mini-harness/tools/api';
import type { ToolResultTransform, InputPreparation, ModelRequestTransform, ModelRetryHandler } from './extensions.js';
import type { Context } from 'cordis';
import type { PluginApi } from '@mini-harness/plugin-api/descriptor';
import { firstDecision, type OrderedHook } from '@mini-harness/kernel/contributions';
import { NativeAgent } from './agent.js';

export function setup(ctx: Context, api: PluginApi) {
  const { harnessRegistry: catalog, harnessScopes: scopes } = ctx;
  const agent = new NativeAgent(catalog, {
    models: (id) => scopes.require(`session:${id}`, 'harnessModels'),
    llm: (id) => scopes.require(`session:${id}`, 'harnessLlm'),
    tools: (id) => scopes.require(`session:${id}`, 'harnessTools'),
    prompt: (id) => scopes.require(`session:${id}`, 'harnessPrompt'),
    prepare: (id, signal) => scopes.prepare(`session:${id}`, signal),
    policy: () => api.config as { maxTurns: number; autoCompact: boolean },
    observe: (event, signal) => ctx.emit('harness/observe', event, signal),
    inputHooks(id) {
      const hooks: OrderedHook<InputPreparation>[] = [];
      ctx.emit('harness/prepare-input', id, hooks);
      return hooks;
    },
    modelRequestHooks(id) {
      const hooks: OrderedHook<ModelRequestTransform>[] = [];
      ctx.emit('harness/model-request', id, hooks);
      return hooks;
    },
    toolResultHooks(id) {
      const hooks: OrderedHook<ToolResultTransform>[] = [];
      ctx.emit('harness/tool-result', id, hooks);
      return hooks;
    },
    retryModel(failure) {
      const hooks: OrderedHook<ModelRetryHandler>[] = [];
      ctx.emit('harness/model-retry', failure.sessionId, hooks);
      return firstDecision(hooks, failure);
    }
  });
  ctx.provide('harnessAgent', agent);
  ctx.effect(() => () => agent.agents.settle());
  ctx.effect(() => ctx.harnessMutations.guard((keys) => {
    if (agent.agents.pendingInScope(keys, (id) => scopes.address(`session:${id}`)))
      throw new DomainError('conflict', 'Stop the affected conversations before changing their providers or plugins');
  }));
  ctx.effect(() => catalog.beforeDelete({
    busy: (id) => agent.agents.has(id),
    quiesce: (ids) => agent.agents.settle(ids)
  }));
}
