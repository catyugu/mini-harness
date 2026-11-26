# Add a tool

Create a [Cordis plugin](creating-a-plugin.md) that injects the Tools service. The following server entry uses the public SDK:

```ts
import type { Context } from 'mini-harness/cordis';
import { defineTool } from 'mini-harness/tools';

export const inject = ['harnessTools'];

export function apply(ctx: Context) {
  ctx.effect(() =>
    ctx.harnessTools.register(
      defineTool({
        name: 'hello',
        description: 'Return a greeting.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: 'Hello' }] };
        },
      }),
    ),
  );
}
```

Enable the built entry in your Profile and ask a configured model to call `hello`. The tool's result is native content, not a provider SDK object. Disable the entry to remove the tool.

For resource-specific work, register a factory and receive the resource ID at resolution rather than guessing a selected conversation. The [scoped greeting example](../examples/scoped-tool/plugin.ts) demonstrates scoped registration and a display transform; the [Task notes example](../examples/task-notes/plugin.ts) records durable conversation data through Sessions.

The [Tools contract](../../packages/tools/README.md) owns validation, inline and background invocation, cancellation and serial/parallel behavior. A tool should declare concurrency safety only when its actual operations are safe to parallelize; a tool that waits on behalf of the owning run must remain serial.
