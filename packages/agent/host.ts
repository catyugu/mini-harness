import type { Context } from 'cordis';
import type { PluginApi } from '../contracts/plugins.js';
import { registerRoutes } from './routes.js';
import { NativeAgent } from './agent.js';

export function setup(ctx: Context, api: PluginApi) {
  const { harnessRegistry: catalog, harnessScopes: scopes, harnessSettingsStore: settings } = ctx;
  const agent = new NativeAgent(catalog, {
    models: (id) => scopes.resolve(id, 'harnessModels') ?? ctx.harnessModels,
    llm: (id) => scopes.resolve(id, 'harnessLlm') ?? ctx.harnessLlm,
    tools: (id) => scopes.resolve(id, 'harnessTools') ?? ctx.harnessTools,
    allowsTool: (id, name) => scopes.allowsTool(id, name),
    prompt: (id) => scopes.resolve(id, 'harnessPrompt') ?? ctx.harnessPrompt,
    skills: (id) => scopes.resolve(id, 'harnessSkills') ?? ctx.get('harnessSkills'),
    prepare: (id, signal) => scopes.prepare(id, signal),
    defaultModel: () => settings.settings.model,
    rememberModel: (model) => {
      // A scoped-only model must not become an unusable global default for siblings.
      try { if (!ctx.harnessModels.resolve(model)) return; }
      catch { return; }
      settings.rememberModel(model);
    },
    policy: () => api.config as { maxTurns: number; autoCompact: boolean },
    observe: (event) => ctx.emit('harness/observe', event),
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
