import { defineTool } from '@mini-harness/contracts/tools';
import type { Context } from 'cordis';
import type { PluginApi } from '@mini-harness/contracts/plugins';
import { Type } from 'typebox';
import { Delegation } from './delegation.js';
import type { SubagentPolicy } from '@mini-harness/contracts/delegation';

/** Optional plugin: delegation, scheduling and child-model rules exist only while mounted. */
export function setup(ctx: Context, api: PluginApi) {
  const { harnessRegistry: catalog, harnessScopes: scopes, harnessRuns: runs } = ctx;
  const policy = () => api.config as unknown as SubagentPolicy;
  const delegation = new Delegation(catalog, { activeModel: (id) => scopes.require(id, 'harnessAgent').activeModel(id) },
    (id) => scopes.require(id, 'harnessModels'), () => runs, policy, (id) => catalog.assertAvailable(id));
  api.onConfigChange((next) => {
    const config = next as unknown as SubagentPolicy;
    delegation.semaphore.setLimit(config.maxParallel);
  });
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
