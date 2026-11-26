# Runs

Runs owns conversation admission, Inbox delivery, model selection and live replay. A Run uses a Task with an exclusive conversation lane. Its Run ID is the Task ID.

## Public API

Import [`mini-harness/runs`](src/api.ts) and inject `harnessRuns`.

```ts
const receipt = ctx.harnessRuns.send(sessionId, {
  message: 'Summarize the open changes.',
  origin: { source: 'user' },
  mode: 'interrupt',
});
```

`send` synchronously commits a message and returns its stable ID, the current queue projection and the active Run when available. An explicit message ID makes retrying acceptance idempotent within its Session. Programmatic senders supply an origin when they can identify the sender and related Task.

| Mode      | Delivery                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------- |
| Steer     | At an available model or tool boundary. A pending steering message can skip tools that have yet to start. |
| Interrupt | Request cancellation immediately and deliver in a new Run after the previous Run drains.                  |
| Queue     | Deliver in a new Run after completion.                                                                    |

`stop` persists a pause before requesting cancellation. Subsequent explicit user input resumes delivery. Notifications accumulate in the Session Log through a pause. `cancelQueue` discards specified pending messages. `reviseAndStart` handles an explicit branch revision, which supplies its own leaf identity.

`info`, `activity` and `watch` expose current state and replay. `retryInput` reads the failed Run's input. `runTask` admits independent plugin work in the same exclusive lane and agent scope, so incoming messages remain durable until it settles. A stopped process cannot resume an old executor. Startup can start new work for pending Inbox messages in unpaused sessions.

## Record publication

Runs owns volatile record updates and their ordered replay. Plugins publish through `publishRecord(sessionId, runId, update)`, using a stable record ID for `set`, channel `append` and `remove` operations. A committed Session display record with the same ID replaces its live counterpart. The producer defines the record's meaning and renderer; Runs does not interpret its channels. The `agent/records` hook supplies the same publication mechanism to observers of raw Agent events.

Foreground tool output is streamed in named channels. Runs owns the bounded active output snapshot and publishes incremental output events; the durable tool result remains the final history source. File-changing plugins report paths using `recordChange` for the matching execution rather than requiring Runs to interpret tool result metadata.

## Independent tools

The optional `task-control` Profile entry registers `start_background` and `task_control`. An eligible tool declares `background: true`; the shared tool invocation path validates and executes it. The accepted receipt identifies its independent Task. `task_control` lists, inspects, waits for, cancels and reads cursor-based output for owned background tools and direct child Runs.

Background execution holds the registered tool's provider and the Session's resource owner. It can call `report` to send a mid-task message. Progress and ordinary output update task projections. Background tool snapshots carry the accepted tool name and arguments. Child Runs keep their conversation output in Session history, not in a duplicate terminal-output stream. Terminal notifications carry the actual scheduler state and the projected business result. Stable notification IDs make acceptance idempotent across restart.

See [execution](../../docs/subsystems/execution.md) and [the Session Log format](../../docs/session-log.md).
