# Run a child agent with a selected provider

Child agents use ordinary sessions, Runs and model providers. The current SDK has no separate subagent-provider registry. To supply another backend, first [register a model provider](adding-a-model-provider.md), then select it for delegation or an explicitly submitted child run.

## Configure model-driven delegation

Enable Subagents in Plugins. An explicit `provider` in a `delegate` call selects that provider and its optional requested `model`. Otherwise, the configured child model takes precedence over the parent model, and an explicit `model` changes the ID within that inherited provider. See [Subagents](../../packages/subagents/README.md) for provider-default resolution and depth/concurrency limits.

Ask a tool-capable model to delegate a task using the registered choice. For the echo example, specify both `provider: "example"` and `model: "echo"`: a provider-only call supplies an empty model ID, and default-model resolution depends on that provider's implementation. Delegation returns a child session ID and task ID immediately, including while queued. Open the child in the conversation tree to inspect its work. Parent-run cancellation does not cancel this independently owned child; deleting the parent conversation removes the descendant tree.

## Submit a child from a plugin

The complete [Task notes follow-up endpoint](../examples/task-notes/plugin.ts) demonstrates this sequence:

1. Inject Sessions, Runs, Models and Profile Scopes through Cordis.
2. Validate the parent and message; prepare `session:<parentId>` before resolving scoped model services.
3. Read the parent's committed model and verify it resolves in that composition.
4. If requested, await `harnessApprovalRequests.request`; denial rejects.
5. Create the child with `harnessSessions.create({ parentId, title })` and send `harnessRuns.send(child.id, { message, model, origin })`.
6. Observe the returned Task Handle and report the child ID, run ID and result.

After enabling Task notes and sending a parent message with a configured model, call its authenticated `POST /api/extensions/task-notes/follow-up` endpoint with `parentId` and `message`. The response waits for the result. Its request signal is passed to the child submission, so disconnecting this particular request cancels that work. This is a deliberate request-bound example, distinct from the independently owned built-in delegation path.

For independent work, return the IDs after admission, select a provider Context that outlives the request, and leave request cancellation out of the submission. Observe task failure and settlement through the [Tasks contract](../../packages/tasks/README.md). If several children share a capacity limit, use one task pool owned by the delegating plugin; follow the built-in [delegation implementation](../../packages/subagents/src/server/delegation.ts).

## Check lifecycle behavior

Verify model selection, queued admission, cancellation, plugin removal and parent deletion. A serial `subagent_control` wait yields the enclosing run's pool capacity while retaining its exclusive session lane. The [execution reference](../subsystems/execution.md) explains the relationship between independent child Runs and ordinary tool calls. Keep delegation policy in the delegating plugin, with generic scheduling in Tasks.
