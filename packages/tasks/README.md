# Tasks

Tasks schedules independently managed async work. It owns opaque resource owners, exclusive lanes, concurrency pools and task observations.

## Public API

Inject `harnessTasks` and use [`mini-harness/tasks`](src/api.ts).

```ts
const pool = new TaskPool(4);
const handle = ctx.harnessTasks.start({ owner: resourceId, pool, lane: resourceId }, async (task) => {
  await task.waitFor(dependencyTaskId);
  return doWork(task.signal);
});
await handle.result;
```

`TaskHandle.result` resolves to the executor's value and rejects with the execution failure or cancellation reason. Use the handle to read its terminal snapshot. Runtime queries address live tasks by ID or opaque resource owner. Subscribers receive submission, transition and cancellation-request events.

## Lifetime and admission

A task can specify its provider Fiber independently of its resource owner. Cancellation requests abort its signal and settlement waits for actual cleanup. A cancelled waiter leaves the independent work it was waiting for running. At a whole-task wait point the executor yields pool capacity, then reacquires capacity before resuming. Exclusive lanes remain occupied during waits. The runtime rejects circular waits.

Owner removal blocks admission while draining that owner's work. Application shutdown seals admission before draining all tasks. After settlement, the runtime releases its references. Consumers own any durable records or output buffers.
