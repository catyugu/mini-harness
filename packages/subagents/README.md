# @mini-harness/subagents

Owns delegation, child model selection, recursion depth and the limit of a shared Task Runtime pool.

The `delegate` tool creates a normal child conversation and submits a normal Agent Run Task. It
returns the child Session ID and Task ID immediately, including when the child is queued. Stop affects
the selected run, not independently owned child conversations. Child sessions remain available for
subsequent runs. Deleting a session recursively drains and deletes its descendants.

`task_control` inspects, waits for or cancels a Task by ID. Waiting is a serial tool call and releases
the current Agent Task's pool capacity while waiting. The optional task-control plugin supplies this tool independently of delegation. Historical child
answers are recovered by Sessions, not by the tool.

The browser contributes a child conversation link to the delegation receipt and a parent navigation
trail. Configuration retains live `maxDepth`, `maxParallel` and child model defaults.

## Usage and limits

Enable the subagents entry. Its [schema](src/manifest.ts) defines maxDepth (default 1, range 0–8), maxParallel (default 4, range 1–16), and model (default null). Changes to pool capacity do not preempt admitted work. The delegate tool takes task and optional provider/model. Its receipt contains sessionId, taskId and state queued; this is acceptance, not a final answer. There is no separate public subagent-provider registry. Use the ordinary model provider contract and [child agent cookbook](../../docs/cookbook/adding-a-subagent-provider.md).

## Testing

[Delegation tests](tests/delegation.test.ts) and [integration tests](tests/integration.test.ts) exercise child execution.

## Related documentation

[Package index](../README.md) · [Execution](../../docs/subsystems/execution.md)
