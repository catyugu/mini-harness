# Tools

Tools owns scoped registration, resolution, validation and execution of tool definitions. Inject `harnessTools` and use [`mini-harness/tools`](src/api.ts) to register typed tools or resource-specific factories.

## Invocation

[`mini-harness/tools/execution`](src/execution.ts) exposes `runTool`, which validates the arguments and returns a Promise for the result.

```ts
const tool = ctx.harnessTools.list({ resourceId: sessionId }).find(({ name }) => name === 'inspect');
if (tool) await runTool(tool, callId, { path: 'README.md' }, { signal });
```

Tool execution uses the providing Cordis Fiber. Registration uses the caller’s service and scope, with an optional explicit provider Context for contributions to another scope. The synchronous unregister function removes the definition and requests cancellation of accepted calls, including independently scheduled calls. It can be called from the tool itself. Fiber disposal waits for execution to settle before releasing its effects. Put resources that require independent disposal in a dedicated provider Fiber, with the registration owned by that Fiber. Removing a scoped override restores inherited selection. A definition selected before a replacement cannot invoke the replacement.

`ToolContext` provides the call ID, cancellation signal, progress updates and an output writer. An execution environment can also supply a whole-task wait function or a background report function. A tool that supports independent execution can declare `background: true` and optionally project a compact result for task history. See [Runs](../runs/README.md#independent-tools) for the built-in background entry.

The default executor runs concurrency-safe calls in bounded groups, with serial calls acting as barriers. It drains started calls before returning. Tool failures and skipped calls close the model protocol through tool results.

Tool results may select presentation metadata using `detailKeys` from their `details`. The execution layer transports `ToolContext.write(text, channel)` for both foreground and background work; consumers own the output buffers. A tool may report an explicit progress state with `update({ state: 'approval' })` or `update({ state: 'running' })`.

`list()` returns resolved tools carrying the selected registration and provider lifetime. Direct unregistered definitions remain valid for `runTool`; independent background work requires a resolved tool.
