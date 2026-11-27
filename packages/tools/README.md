# Tools

Tools owns scoped registration, resolution, validation and execution of tool definitions. Inject `harnessTools` and use [`mini-harness/tools`](src/api.ts) to register typed tools or resource-specific factories.

## Invocation

[`mini-harness/tools/execution`](src/execution.ts) exposes `runTool`, which validates the arguments and returns a Promise for the result.

```ts
const tool = ctx.harnessTools.list({ resourceId: sessionId }).find(({ name }) => name === 'inspect');
if (tool) await runTool(tool, callId, { path: 'README.md' }, { signal });
```

Tool execution uses the providing Cordis Fiber. Removing a registration cancels its accepted calls, including independently scheduled calls. Provider unload drains executing work before releasing resources. Removing a scoped override restores inherited selection. A definition selected before a replacement cannot invoke the replacement.

`ToolContext` provides the call ID, cancellation signal, progress updates and an output writer. An execution environment can also supply a whole-task wait function or a background report function. A tool that supports independent execution can declare `background: true` and optionally project a compact result for task history. See [Runs](../runs/README.md#independent-tools) for the built-in background entry.

The default executor runs concurrency-safe calls in bounded groups, with serial calls acting as barriers. It drains started calls before returning. Tool failures and skipped calls close the model protocol through tool results.

Tool results may select presentation metadata using `detailKeys` from their `details`. The execution layer transports `ToolContext.write(text, channel)` for both foreground and background work; consumers own the output buffers. A tool may report an explicit progress state with `update({ state: 'approval' })` or `update({ state: 'running' })`.
