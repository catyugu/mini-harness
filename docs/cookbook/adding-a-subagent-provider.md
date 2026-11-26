# Run a child agent with a selected provider

There is no separate public subagent-provider registry in the current implementation. Child agents are ordinary sessions and runs using the same [model providers](adding-a-model-provider.md).

For normal model-driven delegation, enable Subagents, set a child default model in its plugin configuration if desired, and let the model call `delegate` with an optional provider/model override. See [Subagents](../../packages/subagents/README.md) for precedence and limits.

An extension can also create a child explicitly using `harnessSessions.create({ parentId, title })` and submit `harnessRuns.submit(child.id, { message, model })`. Both services are declared through native Cordis injection. The resulting handle is a normal Task Handle. If the work must survive a short-lived caller, choose a suitable provider lifetime, resource ownership and cancellation policy; do not retain a run context accidentally.

The runnable [Task notes follow-up endpoint](../examples/task-notes/plugin.ts) checks the parent, prepares its configured scope, resolves the model and creates a child. That example waits for the result with the request signal. For independent work, return the handle ID instead of awaiting it and do not bind cancellation to a short-lived request.

Read [execution](../subsystems/execution.md) before changing delegation or concurrency behavior. The generic runtime and Runs must not acquire delegation-specific scheduling policy.
