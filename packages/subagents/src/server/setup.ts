import type {} from '@mini-harness/plugin-api/scopes';
import type {} from '@mini-harness/sessions/records';
import type {} from '@mini-harness/tools/api';
import type { Context } from 'mini-harness/cordis';
import type {} from '@mini-harness/runs/execution';
import type {} from '@mini-harness/models/api';
import { defineTool } from '@mini-harness/tools/api';
import { Type } from 'typebox';
import { Delegation, type SubagentPolicy } from './delegation.js';

/** Optional plugin: delegation, scheduling and child-model rules exist only while mounted. */
export function setup(ctx: Context) {
  const policy = () => ctx.fiber.effectiveConfig as unknown as SubagentPolicy;
  const delegation = new Delegation(ctx.harnessSessions.access(), ctx.harnessExecution, policy);
  ctx.on('internal/update', (next) => {
    const config = next as unknown as SubagentPolicy;
    delegation.semaphore.setLimit(config.maxParallel);
  });
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
  ctx.effect(() => ctx.harnessTools.register({ name: 'delegate', bind: tool }, { visible: (id) => delegation.visible(id) }));
}
