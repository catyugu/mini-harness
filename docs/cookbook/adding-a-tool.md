# Add a tool

Start with a built [plugin entry](creating-a-plugin.md). A tool contributes a native schema and executor to `harnessTools`; the calling execution layer supplies the task, signal and resource context.

## Register a small tool

This complete server module uses the public SDK and a JSON schema. Save it as `plugin.ts` in your plugin project and compile it using the same TypeScript setup as [Task notes](../examples/task-notes/README.md).

```ts
import type { Context } from 'mini-harness/cordis';
import type { ToolDefinition } from 'mini-harness/tools';

export const inject = ['harnessTools'];

const hello: ToolDefinition<{ name: string }> = {
  name: 'hello',
  description: 'Return a greeting for a name.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1 } },
    required: ['name'],
    additionalProperties: false,
  },
  tags: ['readOnly'],
  isConcurrencySafe: () => true,
  async execute({ name }, { signal }) {
    signal.throwIfAborted();
    return { state: 'finished', content: [{ type: 'text', text: 'Hello, ' + name }] };
  },
};

export function apply(ctx: Context) {
  ctx.effect(() => ctx.harnessTools.register(hello));
}
```

The native executor validates arguments before invocation. `ToolDefinition<Args>` describes the TypeScript side; keep that type consistent with the schema. If you build schemas with TypeBox, `defineTool` infers arguments from the schema instead. Tool results use native text/image content rather than a provider SDK response.

## Activate and exercise it

Add the built directory to the Profile as in the creation walkthrough. Choose a model that supports tool calls and ask it to call `hello` with your name. The displayed result should contain the greeting. Newly enabled tools are advertised on the next model turn. Disable the entry and send another turn: `hello` should no longer be advertised. Removal also immediately invalidates old invocation leases and cancels and drains outstanding calls.

This tool is safe to run concurrently and declares `readOnly` for the built-in conversation tool policy. Omit concurrency safety for operations that require serialization. Pass `context.signal` to cancellable I/O and report progress with `context.update`. Removal revokes outstanding invocations and drains their work.

## Resolve a conversation or another resource

Use a `ToolFactory` when the implementation depends on the resource ID passed by the caller. The [Task notes tool](../examples/task-notes/plugin.ts) resolves the session and writes through Sessions; it does not infer the selected conversation from browser state. The [scoped greeting](../examples/scoped-tool/plugin.ts) demonstrates a contribution mounted specifically in a session scope and a separate display transform.

[Tools](../../packages/tools/README.md) owns argument validation, serial barriers, inline/background invocation and waiting semantics. Use its task-based invocation contract for programmatic calls. A serial tool waiting on behalf of the enclosing run can use `context.waitFor`; do not use that whole-task waiting boundary from a concurrently executing tool.
