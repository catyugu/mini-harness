import { sessionDisplayExtensions, toolExtensions } from 'mini-harness/plugin';

export default function setup(ctx, api) {
  const greeting = ctx.exampleGreeting;
  api.contribute(toolExtensions.register, {
    name: 'scoped_greeting',
    label: 'Scoped greeting',
    description: 'Return a greeting for this conversation.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: greeting.greet(api.scope.sessionId) }] };
    }
  });
  api.contribute(sessionDisplayExtensions.project, ({ tool, content }) => tool === 'scoped_greeting'
    ? [{ type: 'text', text: 'Greeting returned.' }] : content);
}
