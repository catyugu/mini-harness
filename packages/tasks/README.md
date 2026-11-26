# Tasks

The `harnessTasks` Cordis service starts arbitrary asynchronous work. Await the returned handle's
`result` for inline execution, or retain its ID for independent work. The owner key determines
which tasks are drained when their owner is deleted; the provider fiber also constrains their lifetime.
Cancellation is cooperative: the task stays active until execution and resource cleanup settle.
A caller-defined admission function can acquire a slot; `context.suspend` releases it while waiting
and reacquires it before returning. Observe task snapshots with `subscribe` or await a condition with
`wait`. Output is bounded and supports cursor-based incremental reads.
