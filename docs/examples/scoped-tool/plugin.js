import { toolExtensions } from 'mini-harness/plugin';

export default function setup(_ctx, api) {
  const greeting = api.service('exampleGreeting');
  api.contribute(toolExtensions.register, {
    name: 'scoped_greeting',
    label: 'Scoped greeting',
    description: 'Return a greeting for this conversation.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: greeting.greet(api.scope.sessionId) }] };
    }
  });
  api.contribute(toolExtensions.project, ({ tool, content }) => tool === 'scoped_greeting'
    ? [{ type: 'text', text: 'Greeting returned.' }] : content);
}
