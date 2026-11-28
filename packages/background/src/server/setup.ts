import type { Context } from 'mini-harness/cordis';
import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import { defineTool } from '@mini-harness/tools/api';
import { Background } from './work.ts';

const json = (data: unknown) => ({
  state: 'finished' as const,
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});

export function setup(ctx: Context) {
  const work = new Background(ctx, (id) => ctx.get('harnessChanges')?.invalidate('background', id));
  ctx.effect(() => () => work.drain());
  ctx.effect(() =>
    ctx.harnessSessions.beforeDelete({
      busy: (id) => work.busy(id),
      quiesce: (ids) => work.drain(ids),
    }),
  );
  ctx.on('harness/start', () => work.recover());
  ctx.effect(() =>
    ctx.harnessTools.register({
      name: 'start_background',
      resolve: (id) =>
        defineTool({
          name: 'start_background',
          label: 'Background work',
          description:
            'Start an eligible tool independently. Use background_control with the returned work ID.',
          parameters: Type.Object({
            tool: Type.String(),
            arguments: Type.Record(Type.String(), Type.Unknown()),
          }),
          async execute(args, { callId, signal }) {
            signal.throwIfAborted();
            const receipt = work.start(id, args.tool, args.arguments, callId);
            return { ...json(receipt), details: receipt, detailKeys: ['workId', 'state'] };
          },
        }),
    }),
  );
  ctx.effect(() =>
    ctx.harnessTools.register({
      name: 'background_control',
      resolve: (id) =>
        defineTool({
          name: 'background_control',
          label: 'Background work',
          description:
            'List, inspect, read output from, await, or cancel independent tool work in this conversation.',
          parameters: Type.Object({
            action: Type.Union(
              (['list', 'status', 'output', 'wait', 'cancel'] as const).map((action) => Type.Literal(action)),
            ),
            workId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            cursor: Type.Optional(Type.Integer({ minimum: 0 })),
          }),
          isConcurrencySafe: ({ action }) => action !== 'wait',
          async execute({ action, workId, cursor }, context) {
            if (action === 'list') return json(work.list(id).map(({ result: _, ...item }) => item));
            if (!workId) throw new DomainError('invalid_input', 'A background work ID is required');
            if (action === 'output') return json(work.output(id, workId, cursor));
            if (action === 'wait') return json(await work.wait(id, workId, context));
            if (action === 'cancel') work.cancel(id, workId);
            return json(work.status(id, workId));
          },
        }),
    }),
  );
  ctx.inject(['harnessRoutes', 'harnessChanges'], (web) => {
    const { harnessRoutes: routes } = web;
    const add = (method: string, path: string, handler: Parameters<typeof routes.register>[2]) =>
      web.effect(() => routes.register(method, '/api/sessions/:id/background' + path, handler));
    web.effect(() => web.harnessChanges.register('background'));
    add('GET', '', ({ params }) => work.list(params.id));
    add('GET', '/:work/output', ({ params, url }) =>
      work.output(params.id, params.work, Number(url.searchParams.get('after') ?? 0)),
    );
    add('DELETE', '/:work', ({ params }) => ({ cancelled: work.cancel(params.id, params.work) }));
  });
}
