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

`info`, `activity` and `watch` expose current state and replay. `history` combines the selected branch with durable Run attribution and termination records. `wait` waits for the selected conversation's current Run and reads its saved settlement. `retryInput` reads the failed Run's input. `runTask` admits independent plugin work in the same exclusive lane and agent scope, so incoming messages remain durable until it settles. Runs saves admission and settlement as session-scoped plugin records. Settled runs reference the original Assistant entry. `settlements(id)` lists terminal metadata, and `result(id, runId)` reads the answer for one committed run. Startup marks unfinished Runs interrupted and starts fresh work for pending messages in unpaused sessions.

## Record publication

Runs owns volatile record updates and their ordered replay. Plugins obtain `liveRecords(sessionId, runId)` and use its `set`, channel `append` and `remove` operations with stable record IDs. A committed Session display record with the same ID replaces its live counterpart. The producer defines the record's meaning and renderer; Runs does not interpret its channels. Runs dispatches `agent/records` to active contributors for each native Agent event. `runTask(provider, id, work)` schedules independent work in the conversation lane under the Fiber that implements it.

Foreground tool output is streamed in named channels. Runs owns the bounded active output snapshot and publishes incremental output events; the durable tool result remains the final history source. File-changing plugins report paths using `recordChange` for the matching execution rather than requiring Runs to interpret tool result metadata.

See [execution](../../docs/subsystems/execution.md) and [the Session Log format](../../docs/session-log.md).
