import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import { Type } from 'typebox';


export function setup(ctx: Context) {
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
