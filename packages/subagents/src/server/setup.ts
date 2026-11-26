import type { Context } from 'mini-harness/cordis';
import { defineTool } from '@mini-harness/tools/api';
import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import { Delegation, type SubagentPolicy } from './delegation.ts';

/** Optional plugin: delegation, scheduling and child-model rules exist only while mounted. */
export function setup(ctx: Context) {
  const policy = () => ctx.fiber.effectiveConfig as unknown as SubagentPolicy;
  const validate = ({ model }: SubagentPolicy) => {
    if (model && !ctx.harnessModels.resolve(model))
      throw new DomainError('invalid_input', 'Unknown child model: ' + model.provider + '/' + model.id);
  };
  validate(policy());
  const delegation = new Delegation(ctx.harnessSessions, ctx.harnessRuns, policy);
  ctx.on('internal/update', (next) => {
    const config = next as unknown as SubagentPolicy;
    validate(config);
    delegation.semaphore.setLimit(config.maxParallel);
  });
  const tool = (id: string) =>
    defineTool({
      name: 'delegate',
      label: 'Delegate',
      description: 'Start a child agent asynchronously. Returns its session ID and task ID immediately; the child continues independently. Set provider/model to override the default.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 12000 }),
        provider: Type.Optional(Type.String({ maxLength: 160 })),
        model: Type.Optional(Type.String({ maxLength: 160 })),
      }),
      isConcurrencySafe: () => true,
      execute: async (_callId, args, signal) => {
        const child = delegation.delegate(id, args, signal);
        return { content: [{ type: 'text', text: JSON.stringify(child) }], details: child };
      },
    });
  ctx.effect(() =>
    ctx.harnessTools.register({ name: 'delegate', resolve: tool, visible: (id) => delegation.visible(id) }),
  );
}
