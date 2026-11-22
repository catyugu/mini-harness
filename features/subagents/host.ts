import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import { Delegation } from './delegation.js';
import type { SubagentPolicy } from '../../src/contracts/delegation.js';

/** Optional plugin: delegation, scheduling and child-model rules exist only while mounted. */
export function setup(ctx: Context) {
  const delegation = new Delegation(ctx.harnessRegistry, ctx.harnessPi, () => ctx.harnessRuns,
    () => ctx.harnessSettings().pluginConfig.subagents as unknown as SubagentPolicy, (id) => ctx.harnessOperations.assertAvailable(id));
  delegation.validate(ctx.harnessSettings().pluginConfig.subagents as unknown as SubagentPolicy);
  ctx.provide('harnessDelegation', delegation);
  ctx.effect(() => ctx.harnessSettingsStore.validate((next) => delegation.validate(next.pluginConfig.subagents as unknown as SubagentPolicy)));
  ctx.effect(() => ctx.harnessSettingsStore.subscribe(() => delegation.configure()));
  const tool = (id: string) => defineTool({
    name: 'delegate', label: 'Delegate',
    description: 'Create a child agent for a specific task. Set provider/model to override the default.',
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 12000 }),
      provider: Type.Optional(Type.String({ maxLength: 160 })),
      model: Type.Optional(Type.String({ maxLength: 160 }))
    }),
    execute: async (_callId, args, signal) => {
      const child = await delegation.delegate(id, args, signal);
      return { content: [{ type: 'text', text: child.text }], details: { sessionId: child.id } };
    }
  });
  ctx.effect(() => ctx.harnessTools.register('delegate', tool, (id) => delegation.visible(id)));
}
