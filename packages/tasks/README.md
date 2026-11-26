# @mini-harness/tasks

A business-independent asynchronous scheduler. Start an arbitrary async function, await the
returned handle for inline execution, or keep the ID for independent work.

```ts
const pool = tasks.pool(4);
const work = tasks.start(
  { owner: 'resource', lane: 'exclusive-operation', pool, project: (value: string) => value },
  async (task) => {
    task.signal.throwIfAborted();
    task.write('started');
    return 'done';
  },
);
await work.result;
```

An opaque owner groups resource lifetimes; `parentId` defines structured child cancellation and
settlement. A provider Cordis fiber owns executing code. A lane is exclusive through settlement,
even while a task waits. A resizable pool bounds running work. At a whole-task waiting point,
`suspend` and `waitFor(id)` release pool capacity and reacquire it before resumption without
releasing the lane. `waitFor` detects circular task dependencies. `batch` implements bounded
parallelism, serial barriers and cancellation/drain on failure.

Cancellation is cooperative: a task remains active until execution and children settle.
`active(lane)` returns its live handle; `removeOwner` excludes new work during cancellation
and drain, then removes its recent observations. The owner of the resource determines whether
it still exists.

`subscribe` observes runtime activity; an optional per-task `onEvent` observes its own execution.
Output has absolute UTF-8 byte cursors and channel names. `retain: false` discards observations
after settlement; otherwise a bounded cache holds at most 256 recent terminal snapshots and
16 MiB of observations/output, without execution promises or closures. An optional `project`
function produces the serializable result from the executor's actual returned value.

Storage is optional. A task can supply a synchronous `commit` function to record transitions
before their observation. `registerHistory` attaches a read-only history source; `get` and
`readOutput` can retrieve its records, never recreate historical execution handles. `list`
contains only active and recently settled tasks. Tasks does not interpret owner keys, task types,
or metadata, and has no dependency on Sessions, Runs, Tools or Agent.
