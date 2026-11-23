import type { Context } from 'cordis';
import type { PluginApi } from '#mini-harness/contracts/plugins.js';
import { registerRoutes } from './routes.js';
import type { ModelRequestTransform, ToolResultTransform } from '#mini-harness/contracts/extensions.js';
import type { OrderedHook } from '#mini-harness/contracts/events.js';
import { NativeAgent } from './agent.js';

export function setup(ctx: Context, api: PluginApi) {
  const { harnessRegistry: catalog, harnessScopes: scopes, harnessSettingsStore: settings } = ctx;
  const agent = new NativeAgent(catalog, {
    models: (id) => scopes.require(id, 'harnessModels'),
    llm: (id) => scopes.require(id, 'harnessLlm'),
    tools: (id) => scopes.require(id, 'harnessTools'),
    allowsTool: (id, name) => scopes.allowsTool(id, name),
    prompt: (id) => scopes.require(id, 'harnessPrompt'),
    skills: (id) => scopes.optional(id, 'harnessSkills'),
    prepare: (id, signal) => scopes.prepare(id, signal),
    defaultModel: () => settings.settings.model,
    rememberModel: (model) => {
      // A scoped-only model must not become an unusable global default for siblings.
      if (scopes.require(undefined, 'harnessModels').resolve(model)) settings.rememberModel(model);
    },
    policy: () => api.config as { maxTurns: number; autoCompact: boolean },
    observe: (event) => ctx.emit('harness/observe', event),
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
    retryModel: (failure) => ctx.serial('harness/model-retry', failure),
    transform: (projection) => ctx.waterfall('harness/tool-projection', projection, () => projection.content)
  });
  ctx.provide('harnessAgent', agent);
  ctx.effect(() => () => agent.agents.settle());
  ctx.effect(() => catalog.beforeDelete({
    busy: (id) => agent.agents.has(id),
    quiesce: (ids) => agent.agents.settle(ids)
  }));
  registerRoutes(ctx);
}
