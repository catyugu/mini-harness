# Subagents

Subagents contributes the `delegate` tool, child-model selection and a shared Task pool. A delegated child is a normal persisted conversation submitted through [Runs](../runs/README.md); delegation does not create another execution lifecycle.

## Usage and model selection

The base Profile enables the `subagents` entry. `delegate` accepts a task and optional provider/model, then returns `{ sessionId, taskId, state: 'queued' }` immediately. This receipt acknowledges submission; it is neither the final answer nor a query of the task's instantaneous state.

An explicit provider wins over configured defaults. Without one, the configured child model wins over the parent's stored model; an explicit model ID can override the inherited ID. The chosen model is resolved by the ordinary model catalog.

There is no separate public subagent-provider registry. Contribute a [model provider](../../docs/cookbook/adding-a-model-provider.md) or use the public Sessions and Runs APIs for a custom delegation workflow. See [child agent development](../../docs/cookbook/adding-a-subagent-provider.md).

## Limits and ownership

The [schema](src/manifest.ts) defines:

| Setting       | Default | Meaning                                                              |
| ------------- | ------- | -------------------------------------------------------------------- |
| `maxDepth`    | `1`     | Maximum child depth, from 0 through 8; zero disables delegation.     |
| `maxParallel` | `4`     | Shared pool capacity, from 1 through 16.                             |
| `model`       | `null`  | Optional provider/model default; null inherits the parent selection. |

The entry is live. Changing capacity affects queued admissions without interrupting already admitted children. Depth is checked when the tool is exposed and again when a child is created. The plugin's pool bounds its delegated runs; it is not an application-wide task limit.

The child inherits its parent's workspace and remains available for later runs. Its task belongs to the child session and the Subagents provider Fiber, not to the submitting tool task. Stopping the parent run therefore leaves an independently delegated child running. Unloading the provider interrupts work that it owns. Deleting a session recursively drains and deletes descendants through Sessions.

The optional [task-control plugin](../tools/README.md#built-in-entries-and-verification) inspects, waits for or cancels child tasks. Its serial wait releases the enclosing Agent task's pool capacity, allowing deeper delegation to proceed without holding a slot. Sessions supplies retained child results after live execution ends.

## UI and dependencies

The browser contribution renders a child conversation link in the delegation receipt and a parent navigation trail. Conversation owns selection, history and drafts; Subagents does not maintain a second child-conversation store.

The server requires Tools, Sessions, Models, Runs and Tasks. [Delegation tests](tests/delegation.test.ts) cover selection and depth; [integration tests](tests/integration.test.ts) cover independent children, live limits, cancellation and recursive deletion. See [execution](../../docs/subsystems/execution.md) and the [package index](../../docs/packages.md).
