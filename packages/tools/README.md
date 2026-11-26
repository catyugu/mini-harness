# @mini-harness/tools

Registers and resolves scoped tool definitions, validates arguments and dispatches actual invocations through Task Runtime.

`harnessTools.register` accepts a definition or a resource-specific factory. `harnessTools.list({ scope, resourceId })` selects the effective registrations. `defineTool` infers argument types from the schema. Invoke any selected or standalone definition through `startTool(tasks, tool, callId, args, options)` and await its handle for inline work. Independent work supplies its own resource owner and retention policy; a consumer can also bind an explicit task commit function for durable history. Resource IDs are opaque: for session-owned standalone work pass `harnessSessions.task(id)` explicitly. Tool implementations receive `execute(args, context)`. The returned handle belongs to the single actual tool-call task; no wrapper task is created.

A registration is no longer available once replaced or removed. Removal cancels and drains its active Task invocations. The registering provider fiber owns executing code. For independent factory calls, a consumer may explicitly supply its long-lived composition context instead of retaining a short-lived run context.

`mini-harness/tools/execution` supplies the executor contract, `executeTools` and `startTool`. The native executor declares serial/parallel policy, validates calls and delivers exactly one result per call. Task Runtime executes the batch. An optional consumer policy can acknowledge a background task without waiting for completion. Tools that suspend their owning run must be serial.

The optional `@mini-harness/task-control` plugin registers `task_control` independently of
Subagents. It only uses the Task Runtime contract.

Sessions may supply a tool policy, but registration and execution require no Session service.

## Public API and usage

Import [`mini-harness/tools`](src/api.ts) and [`mini-harness/tools/execution`](src/execution.ts). The [tool cookbook](../../docs/cookbook/adding-a-tool.md) provides a minimal registration example.

A definition supplies its schema and async execution function. Its context exposes the call ID, task, signal, update callback and `waitFor`. Calls are serial unless `isConcurrencySafe(args)` permits parallelism. A serial tool may wait on behalf of the enclosing run. Register resource-specific factories when resolution requires an opaque resource ID; do not assume a session. Independent invocation uses the same handle contract as inline work and can bind durable observations explicitly.

## Testing

[Registry tests](tests/registry.test.ts) exercise registration and invocation.

## Related documentation

[Package index](../README.md) · [Execution](../../docs/subsystems/execution.md)
