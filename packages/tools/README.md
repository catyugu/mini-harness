# @mini-harness/tools

Registers and resolves scoped tool definitions, validates arguments and dispatches actual invocations through Task Runtime.

`harnessTools.register` accepts a definition or a resource-specific factory. `harnessTools.list({ scope, resourceId })` selects the effective registrations. `defineTool` infers argument types from the schema. Invoke any selected or standalone definition through `startTool(tasks, tool, callId, args, options)` and await its handle for inline work. Independent work supplies its own resource owner and retention policy. Tool implementations receive `execute(args, context)`. The returned handle belongs to the single actual tool-call task; no wrapper task is created.

A registration is no longer available once replaced or removed. Removal cancels and drains its active Task invocations. The registering provider fiber owns executing code. For independent factory calls, a consumer may explicitly supply its long-lived composition context instead of retaining a short-lived run context.

`mini-harness/tools/execution` supplies the executor contract, `executeTools` and `startTool`. The native executor decides serial/parallel dispatch, validates calls and delivers exactly one result per call. An optional consumer policy can acknowledge a background task without waiting for completion. Tools that suspend their owning run must be serial.

The optional `@mini-harness/task-control` plugin registers `task_control` independently of
Subagents. It only uses the Task Runtime contract.

Sessions may supply a tool policy, but registration and execution require no Session service.
