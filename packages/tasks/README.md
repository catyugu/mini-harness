# Tasks

Tasks schedules independently managed async work. It owns opaque resource owners, exclusive lanes, concurrency pools and task observations.

## Public API

Inject `harnessTasks` and use [`mini-harness/tasks`](src/api.ts).

```ts
const pool = new TaskPool(4);
const handle = ctx.harnessTasks.start({ owner: resourceId, pool, lane: resourceId }, async (task) => {
  await task.waitFor(dependencyTaskId);
  task.write('Starting work\n');
  return doWork(task.signal);
});
await handle.result;
```

`TaskHandle.result` returns the executor's value. A caller can separately query snapshots, subscribe to updates, read bounded output by byte cursor and request cancellation. Use `project` to publish a serializable result. Output allocation begins at the first write.

## Lifetime and admission

A task can specify its provider Fiber independently of its resource owner. Cancellation requests abort its signal and settlement waits for actual cleanup. A cancelled waiter leaves the independent work it was waiting for running. At a whole-task wait point the executor yields pool capacity, then reacquires capacity before resuming. Exclusive lanes remain occupied during waits. The runtime rejects circular waits.

Owner removal blocks admission and drains that owner's work. Application shutdown seals admission before draining tasks. A synchronous `commit` records transitions before successful acknowledgment. `registerHistory` supplies read-only observations for durable owners such as [Sessions](../sessions/README.md).
