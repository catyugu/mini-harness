export const inject = ["exampleGreeting", "harnessTools"];
import { pluginScope } from 'mini-harness/plugin';

export function apply(ctx) {
  const greeting = ctx.exampleGreeting;
  ctx.effect(() => ctx.harnessTools.register({
    name: 'scoped_greeting',
    label: 'Scoped greeting',
    description: 'Return a greeting for this conversation.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: greeting.greet(pluginScope(ctx).sessionId) }] };
    }
  }));
  ctx.on("conversation/tool-projection", ({ tool, content }) => tool === 'scoped_greeting'
    ? [{ type: 'text', text: 'Greeting returned.' }] : content);
}
