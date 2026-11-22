import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import type { BuiltinPlugin } from '../plugins.js';
import { selectChildModel } from '../subagents.js';

export const subagents: BuiltinPlugin = {
  id: 'subagents', title: 'Subagents', description: 'Delegate tasks to child conversations.',
  preferences: { key: 'subagents', schema: { ...Type.Object({
    maxDepth: Type.Integer({ title: 'Maximum child depth', minimum: 0, maximum: 8 }),
    maxParallel: Type.Integer({ title: 'Parallel children', minimum: 1, maximum: 16 }),
    provider: Type.Optional(Type.String({ title: 'Child provider' })),
    model: Type.Optional(Type.String({ title: 'Child model' }))
  }) } },
  icon: 'delegate', browser: '/builtins/subagents.js', inject: ['harnessTools', 'harnessConfig', 'harnessDelegation'],
  setup(ctx: Context) {
    const delegation = ctx.harnessDelegation;
    const tool = (id: string) => defineTool({
      name: 'delegate', label: 'Delegate',
      description: 'Create a child agent for a specific task. Set provider/model to override the default.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 12000 }),
        provider: Type.Optional(Type.String({ maxLength: 160 })),
        model: Type.Optional(Type.String({ maxLength: 160 }))
      }),
      execute: async (_callId, args, signal) => {
        const choice = selectChildModel(args, ctx.harnessConfig.get().subagents, delegation.parentModel(id));
        const child = await delegation.run(id, args.task, choice, signal);
        return { content: [{ type: 'text', text: child.text }], details: { sessionId: child.id } };
      }
    });
    ctx.effect(() => ctx.harnessTools.register(tool(''), tool,
      (id) => delegation.depth(id) < ctx.harnessConfig.get().subagents.maxDepth));
  }
};
