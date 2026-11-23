import { defineTool } from '../contracts/tools.js';
import type { Context } from 'cordis';
import type { PluginApi } from '../contracts/plugins.js';
import { Type } from 'typebox';
import { Delegation } from './delegation.js';
import type { SubagentPolicy } from '../contracts/delegation.js';
import type { AgentPort } from '../contracts/services.js';
import type { ModelCatalogPort } from '../contracts/models.js';

/** Optional plugin: delegation, scheduling and child-model rules exist only while mounted. */
export function setup(ctx: Context, { config }: PluginApi) {
  const { harnessRegistry: catalog, harnessAgent: agent, harnessScopes: scopes, harnessRuns: runs, harnessSettingsStore: settings } = ctx;
  const policy = () => settings.settings.pluginConfig.subagents as unknown as SubagentPolicy;
  const delegation = new Delegation(catalog, { activeModel: (id) => (scopes.resolve<AgentPort>(id, 'harnessAgent') ?? agent).activeModel(id) },
    (id) => id ? scopes.resolve<ModelCatalogPort>(id, 'harnessModels') ?? ctx.harnessModels : ctx.harnessModels, () => runs, policy, (id) => catalog.assertAvailable(id));
  delegation.validate(config as unknown as SubagentPolicy);
  ctx.effect(() => settings.validate((next) => {
    if (next.plugins.subagents) delegation.validate(next.pluginConfig.subagents as unknown as SubagentPolicy);
  }));
  ctx.effect(() => settings.subscribe(() => delegation.semaphore.setLimit(policy().maxParallel)));
  ctx.provide('harnessDelegation', delegation);
  const tool = (id: string) => defineTool({
    name: 'delegate', label: 'Delegate',
    description: 'Create a child agent for a specific task. Set provider/model to override the default.',
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 12000 }),
      provider: Type.Optional(Type.String({ maxLength: 160 })),
      model: Type.Optional(Type.String({ maxLength: 160 }))
    }),
    isConcurrencySafe: () => true,
    execute: async (_callId, args, signal) => {
      const child = await delegation.delegate(id, args, signal);
      return { content: [{ type: 'text', text: child.text }], details: { sessionId: child.id } };
    }
  });
  ctx.effect(() => ctx.harnessTools.register('delegate', tool, (id) => delegation.visible(id)));
}
