# Tools

Tools owns scoped tool registrations and the invocation contract. It validates arguments and starts each actual call through [Tasks](../tasks/README.md). Resource IDs are opaque; registration and execution do not require Sessions or a conversation policy.

## Registering and selecting tools

[`mini-harness/tools`](src/api.ts) exports `ToolDefinition`, `ToolFactory`, execution context and result types. Inject `harnessTools` and bind registrations to activation with `ctx.effect(() => ctx.harnessTools.register(definition))`.

A definition supplies its name, description, JSON schema and async `execute(args, context)`. `defineTool` infers arguments from a TypeBox schema. Tags and metadata belong to the consumer. Use a factory when resolution needs a resource ID; its optional `visible` predicate controls discovery.

`list({ scope, resourceId })` resolves the nearest visible registration for each name. Without an explicit scope it uses the caller's scope. A factory requires a resource ID, and duplicate names in one scope are rejected. A selected definition carries a registration lease: replacement or removal makes a stale definition unavailable instead of silently invoking new code.

The [tool cookbook](../../docs/cookbook/adding-a-tool.md) gives a minimal registration; [Task notes](../../docs/examples/task-notes/plugin.ts) demonstrates a resource-specific factory.

## Invocation and lifetime

[`mini-harness/tools/execution`](src/execution.ts) exports `startTool`, `executeTools` and the executor contract. For a selected definition, this is the invocation boundary:

```ts
import { startTool } from 'mini-harness/tools/execution';

// Inside a plugin with injected harnessTasks, using a selected tool:
const handle = startTool(ctx.harnessTasks, tool, callId, args, {
  parentTask,
  resourceId,
});
const result = await handle.result;
```

The handle belongs to the actual tool-call task; no wrapper task is created. Inline work supplies `parentTask`. Independent work supplies its own owner and retention policy, and may bind durable transitions explicitly, for example with `harnessSessions.task(sessionId)`. `context` re-resolves a factory against a long-lived composition when independent work would otherwise retain a short-lived caller.

The registering provider Fiber owns executing code. Removing a registration cancels and drains its active invocations. The tool context supplies `callId`, its task and signal, progress updates and `waitFor`. A tool that waits on behalf of its enclosing run must be serial and wait at a whole-task boundary.

## Executor contract

An executor presents advertised schemas, interprets the model response and delivers one result per tool call. Agent validates call/result identities around this boundary.

The native executor validates arguments before invoking code. Calls are serial unless `isConcurrencySafe(args)` permits parallelism; serial calls form barriers between parallel groups. Invalid arguments, missing registrations and execution errors become model-visible error results. Consumer admission policy may return a denied or skipped result without executing a call.

A consumer can accept a background call through `ToolExecution.background`. The model receives one `{ taskId, state: 'queued' }` receipt immediately; this is acceptance, not a live state query. Later completion is observed through task history, not delivered as a second tool result. The background task's owner, provider and signal define its lifetime.

## Built-in entries and verification

The base Profile mounts `core:tools` for registration, `core:tool-executor` for native execution and the optional `task-control` entry. The latter contributes `task_control` to inspect, wait for or cancel any task by ID, independently of Subagents. Its wait operation is serial so it can release the enclosing task's pool capacity.

[Registry tests](tests/registry.test.ts) cover scoped selection, stale leases, removal and standalone invocation. [Agent tests](../agent/tests/execution.test.ts) cover protocol validation, batch failure and background receipts. See [execution](../../docs/subsystems/execution.md) and the [package index](../../docs/packages.md).
