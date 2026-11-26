# Tasks

Tasks is the business-independent asynchronous runtime. It owns live task state, admission, cancellation and settlement. An opaque owner identifies a resource lifetime; Tasks does not interpret sessions, tool names or other domain metadata.

## Public API and usage

Import [`mini-harness/tasks`](src/api.ts) and inject `harnessTasks`. The base Profile mounts `core:tasks`. Use the same `start` API for inline and independent work:

```ts
import type { Context } from 'mini-harness/cordis';
import 'mini-harness/tasks';

export function startWork(ctx: Context) {
  return ctx.harnessTasks.start({ owner: 'example', project: (value: string) => value }, async (task) => {
    task.signal.throwIfAborted();
    task.write('started');
    return 'done';
  });
}
```

Await `handle.result` for the executor's actual JavaScript value, or retain `handle.id` for later observation. A retained snapshot contains only the serializable value returned by `project`, not the executor's objects or closures. `retain: false` releases observations after settlement and result delivery.

## Ownership and admission

| Mechanism  | Contract                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------- |
| `owner`    | Groups work for resource deletion; resource existence belongs to the domain.                 |
| `parentId` | Creates an inline child, cancelled and drained before its parent settles.                    |
| `provider` | Identifies the Cordis Fiber whose code executes the work; defaults to the submitting caller. |
| `lane`     | Admits one task from submission through settlement; another submission fails while occupied. |
| `pool`     | Bounds running work; changing `limit` affects admission without preempting admitted work.    |
| `signal`   | Adds a caller-controlled cancellation lifetime.                                              |

Independent work omits `parentId`; pass a long-lived provider when the submitting plugin or run can end sooner than the work. Creating a task does not establish a parent relationship by itself.

Cancellation is a request, reflected by `cancellationRequested`. The task stays active until execution and inline children finish cleanup. A queued cancelled task never invokes user code. Provider disposal and runtime shutdown cancel and drain owned work; shutdown records interruption rather than successful completion. Arbitrary async functions must cooperate with their signal.

`removeOwner` excludes new admission during cancellation and drain, then removes recent observations. The domain remains responsible for deleting the resource and its durable records.

## Waiting and batches

Inside an executor, `task.suspend(wait)` and `task.waitFor(id)` mark a whole-task waiting point, release pool capacity and reacquire it before normal resumption or a caught wait failure. A lane remains occupied throughout. These calls must be awaited and cannot run concurrently with other work in the same task. Circular task waits are rejected.

External observers use `tasks.wait(id, signal)`; it observes settlement without yielding another task's pool capacity. Cancelling an observer does not cancel the observed task.

`batch` executes concurrency-safe jobs up to a limit and treats serial jobs as barriers. Failure cancels and drains active jobs before returning.

## Observations and persistence

`get`, `list`, `subscribe` and `readOutput` expose snapshots and output. Output cursors are absolute UTF-8 byte offsets; callers check `truncated` when older chunks have been evicted. The terminal cache is bounded, so `list` is not a durable task inventory.

A retained task can supply synchronous `commit` to persist transitions before observers receive them. A failed commit cannot acknowledge successful execution. `registerHistory` adds a read-only source for historical snapshots and output; it never reconstructs execution handles or replays side effects. [Sessions](../sessions/README.md) supplies the conversation-specific durable adapter.

## Verification

[Runtime tests](tests/runtime.test.ts) cover admission, ownership, waits, cancellation, UTF-8 output and persistence failures. See [execution](../../docs/subsystems/execution.md), [Tools](../tools/README.md) and the [package index](../../docs/packages.md).
