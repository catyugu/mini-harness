import type {} from '@mini-harness/kernel/observations';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/models/api';
import type {} from '@mini-harness/llm/api';
import type {} from '@mini-harness/tools/api';
import type { ToolProjectionHandler } from '@mini-harness/sessions/display-extensions';
import type { ToolResultTransform, InputPreparation, ModelRequestTransform, ModelRetryHandler } from './extensions.js';
import type { Context } from 'cordis';
import type { PluginApi } from '@mini-harness/plugin-api/descriptor';
import { registerRoutes } from './routes.js';
import { firstDecision, orderHooks, type OrderedHook } from '@mini-harness/kernel/contributions';
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
