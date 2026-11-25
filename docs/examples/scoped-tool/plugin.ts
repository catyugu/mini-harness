import type { Context } from 'mini-harness/cordis';
import type { ToolPort } from 'mini-harness/tools';
import type { ToolProjection } from 'mini-harness/conversation/display-events';
import type { Greeting } from '../greeting-service/plugin.ts';

export const inject = ['exampleGreeting', 'harnessTools'];
import { pluginScope } from 'mini-harness/plugin-scope';

export function apply(ctx: Context) {
  const greeting: Greeting = ctx.exampleGreeting;
  const tools: ToolPort = ctx.harnessTools;
  const scope = pluginScope(ctx);
  if (scope.kind !== 'session') throw new Error('This plugin belongs to a session');
  ctx.effect(() =>
    tools.register({
      name: 'scoped_greeting',
      label: 'Scoped greeting',
      description: 'Return a greeting for this conversation.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: [{ type: 'text', text: greeting.greet(scope.sessionId) }] };
      },
    }),
  );
  ctx.on('conversation/tool-projection', ({ tool, content }: ToolProjection) =>
    tool === 'scoped_greeting' ? [{ type: 'text', text: 'Greeting returned.' }] : content,
  );
}
