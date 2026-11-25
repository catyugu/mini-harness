# @mini-harness/runs

Schedules and owns active runs and their replay streams.

## Responsibilities

Owns run IDs, admission, model selection, input queues, compaction scheduling and bounded event replay. It prepares requests for the Agent Loop and writes accepted input, request snapshots and results to Sessions.

## Structure

`src/runs.ts` coordinates execution. `session-run.ts` connects the Agent Loop to conversation history. `events.ts` retains bounded server replay and the current response. `routes.ts` adapts run commands and `stream.ts` defines the event union.

## API

`harnessRuns` is the internal scheduler. `harnessExecution` provides scoped submission, status and instance-owned cancellation to native and installed plugins. Runs reads the model preference at admission and publishes accepted input to capability observers; Conversation consumes replay and activity.

## Dependencies

Prepares persisted session composition, tags the run's Cordis context with the session-owned execution key and resolves [Agent](../agent/README.md) services and records run transitions through [Sessions](../sessions/README.md).

## Lifecycle

`core:runs` mounts at application scope. HTTP returns the admitted run without waiting for input delivery. Subscribers may disconnect without cancelling work. Shutdown aborts and drains active runs. Failed runs identify the accepted input by stable Session Log entry ID.

## Testing

`tests/runs.test.ts` covers reconnect, durable run recovery, subtree cancellation and append failures.
