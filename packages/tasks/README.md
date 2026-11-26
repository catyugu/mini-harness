# @mini-harness/tasks

`harnessTasks` starts asynchronous work through a single execution primitive. Await the returned
handle's result for inline execution, or retain its ID for independent work. The owner key determines
which work is drained when a resource is deleted; `parentId` binds an inline child to an active task.
Creator and resource annotations are ordinary metadata. The provider Cordis fiber controls the lifetime of executing code.

Cancellation is cooperative. A task remains active until its executor and owned work have settled.
`pool(limit)` creates a shared concurrency budget with a live limit. `lane` provides exclusive
admission through settlement, including during pool suspension; `active(lane)` returns its handle. `suspend` is a whole-task
waiting point: it releases pool capacity and reacquires it before returning or propagating an ordinary wait error. A cancelled wait does not resume work.
`waitFor(id)` rejects circular waits. `batch` dispatches jobs with bounded parallelism and serial barriers,
then cancels and drains started jobs on failure. Waiting reuses the execution promise and observes the committed terminal state, even for ephemeral tasks.

`subscribe` observes creation, updates, output and removal from the recent runtime view. Subscriptions
are scoped to the consumer fiber. Output uses absolute UTF-8 byte cursors and channel names.
`retain: false` removes a task after settlement; otherwise the runtime retains at most 256 recent
terminal snapshots, subject also to a 16 MiB aggregate observation/output budget (without their result promises or executor closures). `task.setResult` sets the serializable observation result independently of the actual JavaScript value returned by the handle.

Resource domains may handle the Cordis `tasks/admit`, `tasks/record` and `tasks/history` events.
Sessions owns long-term history in SessionLog, including retained background tasks and conversation runs.
Every retained task uses the same synchronous durable transition hook; observers run only after commit. `list` returns active and recent tasks; `get` and `readOutput` can also retrieve a durable
record by ID. Recovery records interrupted work rather than restarting unknown side effects.

`removeOwner` excludes new work until removal settles. The resource domain is responsible for
rejecting work addressed to deleted resources. The runtime has no session or agent dependency.
