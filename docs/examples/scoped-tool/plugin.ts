import type { Context } from 'mini-harness/cordis';
import type { ToolPort } from 'mini-harness/tools';
import type { ToolProjection } from 'mini-harness/conversation/display-events';
import type { Greeting } from '../greeting-service/plugin.ts';

export const inject = ['exampleGreeting', 'harnessTools', 'harnessSessions'];
import { scopeOf } from 'mini-harness/scopes';

export function apply(ctx: Context) {
  const greeting: Greeting = ctx.exampleGreeting;
  const tools: ToolPort = ctx.harnessTools;
  const sessions = ctx.harnessSessions;
  const sessionId = sessions.list().find(({ id }) => sessions.scope(id) === scopeOf(ctx))!.id;
  ctx.effect(() =>
    tools.register({
      name: 'scoped_greeting',
      label: 'Scoped greeting',
      description: 'Return a greeting for this conversation.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { state: 'finished', content: [{ type: 'text', text: greeting.greet(sessionId) }] };
      },
    }),
  );
  ctx.on('conversation/tool-projection', ({ tool, content }: ToolProjection) =>
    tool === 'scoped_greeting' ? [{ type: 'text', text: 'Greeting returned.' }] : content,
  );
}
