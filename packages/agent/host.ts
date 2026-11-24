import type { ToolProjectionHandler, ToolResultTransform } from '@mini-harness/contracts/tool-extensions';
import type { Context } from 'cordis';
import type { InputPreparation, ModelRequestTransform, ModelRetryHandler } from '@mini-harness/contracts/agent-extensions';
import type { PluginApi } from '@mini-harness/contracts/plugins';
import { registerRoutes } from './routes.js';
import { firstDecision, orderHooks, type OrderedHook } from '@mini-harness/contracts/contributions';
import { NativeAgent } from './agent.js';

export function setup(ctx: Context, api: PluginApi) {
  const { harnessRegistry: catalog, harnessScopes: scopes, harnessModelPreference: preference } = ctx;
  const agent = new NativeAgent(catalog, {
    models: (id) => scopes.require(id, 'harnessModels'),
    llm: (id) => scopes.require(id, 'harnessLlm'),
    tools: (id) => scopes.require(id, 'harnessTools'),
    prompt: (id) => scopes.require(id, 'harnessPrompt'),
    prepare: (id, signal) => scopes.prepare(id, signal),
    defaultModel: preference.recent,
    rememberModel: preference.remember,
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
    },
    transform(projection) {
      const hooks: OrderedHook<ToolProjectionHandler>[] = [];
      ctx.emit('harness/tool-projection', projection.sessionId, hooks);
      let content = projection.content;
      for (const { invoke } of orderHooks(hooks)) content = invoke({ ...projection, content }) ?? content;
      return content;
    }
  });
  ctx.provide('harnessAgent', agent);
  ctx.effect(() => () => agent.agents.settle());
  ctx.effect(() => catalog.beforeDelete({
    busy: (id) => agent.agents.has(id),
    quiesce: (ids) => agent.agents.settle(ids)
  }));
  registerRoutes(ctx);
}
