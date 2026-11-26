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
