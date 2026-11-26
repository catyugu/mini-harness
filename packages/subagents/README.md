# @mini-harness/subagents

Owns delegation, child model selection, recursion depth and parallel admission policy.

The `delegate` tool creates a normal child conversation and submits a normal Agent Run Task. It
returns the child Session ID and Task ID immediately, including when the child is queued. Stop affects
the selected run, not independently owned child conversations. Child sessions remain available for
subsequent runs. Deleting a session recursively drains and deletes its descendants.

`task_control` inspects, waits for or cancels a Task by ID. Waiting is a serial tool call and releases
the current Agent Task's admission slot while waiting. The final child answer is read from SessionLog,
not duplicated into a second result database.

The browser contributes a child conversation link to the delegation receipt and a parent navigation
trail. Configuration retains live `maxDepth`, `maxParallel` and child model defaults.
