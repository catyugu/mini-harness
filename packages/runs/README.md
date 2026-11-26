# Runs

Runs coordinates persisted conversation execution. It owns input preparation, model selection, inbox delivery, compaction and transient replay. [Tasks](../tasks/README.md) owns the live lifecycle, and [Sessions](../sessions/README.md) owns durable conversation state.

## Public API and usage

Import [`mini-harness/runs`](src/api.ts) and inject `harnessRuns`. Submit to an existing conversation:

```ts
import type { Context } from 'mini-harness/cordis';
import 'mini-harness/runs';

export function submitMessage(ctx: Context, sessionId: string, message: string) {
  return ctx.harnessRuns.submit(sessionId, { message });
}
```

`submit` returns the original Task Handle; its ID is also the Run ID. Await `result` for the answer, cancel through the handle, or keep its ID for observation. Do not wrap submission in another task. `RunInput` can specify a model, thinking level and attachments; `RunSubmission` adds an explicit provider, signal, pool, metadata and observation callback. SDK submissions default to source `plugin`.

The base Profile's `core:runs` entry requires Profile scopes, Sessions, Agent, Models, Tool Executor and Tasks. Prompt composition, recent-model preference and HTTP routing are optional capabilities.

## Admission and lifetime

A run and manual compaction share one exclusive conversation lane. `current(id)` returns whichever Task Handle currently occupies it. A second submission fails while that lane is occupied, including queued or waiting work. Admission persists the task before returning; it does not imply that user input has been delivered or that a model request has started.

Runs prepares the configured session scope, creates a run Fiber, invokes `agent/setup`, then executes Agent against Session Log. Disposing that Fiber releases run-local contributions. The supplied Task provider and cancellation options determine execution lifetime; a child conversation is not implicitly cancelled with its creator.

HTTP admission is separate from event subscription. Disconnecting a subscriber does not stop the run. Session deletion and application shutdown drain work through its task owner.

## Conversation operations

| Operation          | Observable behavior                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `info`, `activity` | Read the latest run projection and transient text/tool progress.                                          |
| `watch`            | Observe a specific Run ID after a cursor; stale or unavailable replay becomes a snapshot where supported. |
| `queueInput`       | Persist steering or follow-up input for an active execution context.                                      |
| `cancelQueue`      | Cancel pending inbox items without creating a run.                                                        |
| `reviseAndStart`   | Validate the source user entry and expected branch leaf before admitting a revised run.                   |
| `retryInput`       | Recover the accepted input associated with the current failed Run ID, including missing attachments.      |
| `compact`          | Run manual compaction on the same exclusive lane.                                                         |

Queue delivery and branch changes are committed by Sessions. Failed runs identify accepted input by its stable log entry ID. Restart recovers interrupted state from durable records; it does not resume unknown side effects. See [Session Log](../../docs/session-log.md) for the record and recovery contract.

## Events and extension points

The SDK declares `run-started`, `run-ended` and `input-accepted` capability observations. `events` and `watch` support run projections, while [Agent hooks](../agent/README.md#conversation-hooks) customize conversation execution. Observers do not own task state, and an optional submission `emit` callback cannot terminate the run by throwing.

[Task notes](../../docs/examples/task-notes/plugin.ts) demonstrates normal child submission. [Run tests](tests/runs.test.ts) cover admission, restart, replay, persistence faults and retry identity. See the [execution reference](../../docs/subsystems/execution.md) and [package index](../../docs/packages.md).
