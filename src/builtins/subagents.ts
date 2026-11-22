import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import type { BuiltinPlugin } from '../plugin-api.js';
import type { Delegation } from './delegation.js';

declare module 'cordis' {
  interface Context { harnessDelegation: Delegation }
}

export const subagents: BuiltinPlugin = {
  id: 'subagents', title: 'Subagents', description: 'Delegate tasks to child conversations.',
  preferences: { key: 'subagents', groups: [
    { title: 'Run limits', fields: ['maxDepth', 'maxParallel'] },
    { title: 'Model selection', fields: ['provider', 'model'] }
  ], schema: { ...Type.Object({
    maxDepth: Type.Integer({ title: 'Maximum child depth', minimum: 0, maximum: 8 }),
    maxParallel: Type.Integer({ title: 'Parallel children', minimum: 1, maximum: 16 }),
    provider: Type.Optional(Type.String({ title: 'Child provider' })),
    model: Type.Optional(Type.String({ title: 'Child model' }))
  }) } },
  icon: 'delegate', browser: '/builtins/subagents.js', inject: ['harnessTools', 'harnessDelegation'],
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
        const child = await delegation.delegate(id, args, signal);
        return { content: [{ type: 'text', text: child.text }], details: { sessionId: child.id } };
      }
    });
    ctx.effect(() => ctx.harnessTools.register('delegate', tool, (id) => delegation.visible(id)));
  }
};
